# 03 — 刷新编排：事件分类 + 单飞合并 + 写后抑制

**What to build:** 让「变更 → 刷新」这一步不再放大成本：

1. 后端 `repo-changed` 从空载荷改成携带**变更分类**，并把防抖从**前沿**改成**尾沿**
   （现在的前沿防抖会把同一串变更的后续事件整个丢掉）。
2. 前端按分类分流：只有 refs / HEAD 变才重拉 log；工作区 / 索引变只重拉 status。
3. `refresh()` 改**单飞 + 合并 + 等待**（补跑档位按请求取重），并把写操作自己触发的那一轮抑制掉
   —— 写操作刷新轮数 **2 → 1**。

**不改**：命令签名、`GitError`、`get_branch_summary`（保留 —— 它被 20+ 处测试直接消费）。

## 1) `watcher.rs`：分类载荷 + 尾沿防抖

```rust
use serde::Serialize;

/// `repo-changed` 的载荷：哪些数据面需要重拉
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct RepoChange {
    /// `.git/index` 变：暂存 / 工作区状态
    pub index: bool,
    /// `refs/**` 或 `packed-refs` 变：分支 / 标签 / 远程 ref
    pub refs: bool,
    /// `.git/HEAD` 变：当前分支或检出点
    pub head: bool,
    /// 工作区文件变（`.git` 之外的路径）
    pub worktree: bool,
}

impl RepoChange {
    /// 只有 ref / HEAD 变才可能改变提交历史视图
    pub fn needs_log(&self) -> bool {
        self.refs || self.head
    }
    pub fn is_empty(&self) -> bool {
        !(self.index || self.refs || self.head || self.worktree)
    }
    pub fn merge(&mut self, other: RepoChange) {
        self.index |= other.index;
        self.refs |= other.refs;
        self.head |= other.head;
        self.worktree |= other.worktree;
    }
}

/// 把 notify 报的路径分类。纯函数，可单测。
///
/// - `<root>/.git/index` → index
/// - `<root>/.git/refs/**`、`<root>/.git/packed-refs` → refs
/// - `<root>/.git/HEAD` → head
/// - 其它 `<root>/.git/**`（objects / logs / ORIG_HEAD / FETCH_HEAD / *.lock）→ 不置位
/// - 其余（`.git` 之外）→ worktree
pub fn classify(root: &Path, paths: &[PathBuf]) -> RepoChange {
    let git = root.join(".git");
    let mut c = RepoChange::default();
    for p in paths {
        let Ok(rel) = p.strip_prefix(&git) else {
            c.worktree = true;
            continue;
        };
        let first = rel.components().next();
        match first {
            Some(std::path::Component::Normal(name)) if name == "index" => c.index = true,
            Some(std::path::Component::Normal(name)) if name == "HEAD" => c.head = true,
            Some(std::path::Component::Normal(name)) if name == "refs" || name == "packed-refs" => {
                c.refs = true
            }
            _ => {} // objects / logs / 各类 lock 等：不改变可见数据面
        }
    }
    c
}
```

防抖改成尾沿（现状是前沿：首个事件就发出、窗口内其余事件被丢弃，可能出现「刷新读到写到一半的状态、
且没有尾随事件补救」）：

```rust
struct Pending {
    change: RepoChange,
    /// 静默到什么时候才算结束（每个新事件都往后推）
    deadline: Option<Instant>,
    /// 是否已有计时线程在跑
    armed: bool,
}

pub fn start(app: &AppHandle, root: &Path) -> notify::Result<RecommendedWatcher> {
    let app = app.clone();
    let root = root.to_path_buf();
    let pending: Arc<Mutex<Pending>> = Arc::new(Mutex::new(Pending {
        change: RepoChange::default(),
        deadline: None,
        armed: false,
    }));
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        let Ok(event) = res else { return };
        let Ok(mut p) = pending.lock() else { return };
        p.change.merge(classify(&root, &event.paths));
        p.deadline = Some(Instant::now() + DEBOUNCE);
        if p.armed {
            return; // 已有计时线程，它会看到被推后的 deadline
        }
        p.armed = true;
        drop(p);
        spawn_flush(app.clone(), Arc::clone(&pending));
    })?;
    watcher.watch(&root.join(".git"), RecursiveMode::Recursive)?;
    watcher.watch(root, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

/// 尾沿防抖：窗口内持续有新事件就不断延后，静默 DEBOUNCE 后一次性发出累积分类
fn spawn_flush(app: AppHandle, pending: Arc<Mutex<Pending>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(DEBOUNCE);
        let Ok(mut p) = pending.lock() else { return };
        let Some(deadline) = p.deadline else {
            p.armed = false;
            return;
        };
        if Instant::now() < deadline {
            continue; // 窗口被推后，继续等（guard 在下一轮循环重新获取）
        }
        let change = std::mem::take(&mut p.change);
        p.deadline = None;
        p.armed = false;
        drop(p);
        // 只动了 objects / logs 之类的变更不改变任何可见数据面 → 不发事件
        if !change.is_empty() {
            let _ = app.emit("repo-changed", change);
        }
        return;
    });
}
```

**本票不修、但要记录的两个边界**（写进 Comments）：
- linked worktree 下 `root/.git` 是**文件**，`watcher.watch(root.join(".git"), Recursive)` 会失败 →
  `open_repo` 里 `.ok()` 吞掉 → 该仓库没有外部变更监听（既有缺陷，非本票引入）。
- 工作区监听是 `RecursiveMode::NonRecursive` → **只有仓库根目录下的直接文件**变更会被看到，
  `src/**` 里的存盘不会触发（故「工作区变更不重拉 log」的收益只覆盖根目录文件）。

## 2) 前端类型与接线

`src/lib/types.ts`：

```ts
/** 后端 `repo-changed` 的载荷：变更分类（决定哪些数据面需要重拉） */
export interface RepoChange {
  index: boolean;
  refs: boolean;
  head: boolean;
  worktree: boolean;
}
```

`src/lib/ipc.ts`（回调改为带载荷）：

```ts
export function listenRepoChanged(cb: (change: RepoChange) => void): Promise<() => void> {
  return import("@tauri-apps/api/event").then(({ listen }) =>
    listen<RepoChange>("repo-changed", (e) => cb(e.payload)).then((un) => () => {
      un();
    }),
  );
}
```

`src/App.tsx`（`useEffect` 里那一行）：

```ts
const un = listenRepoChanged((change) => void useRepo.getState().applyRepoChange(change));
```

## 3) `src/stores/repo.ts`

新增状态：`refreshBusy: boolean`、`refreshDirty: boolean`、`refreshHeavy: boolean`、
`refreshWaiters: (() => void)[]`、`lastWriteAt: number`。新增接口方法 `applyRepoChange` /
`refreshLight`。导出常量：

```ts
/** 写操作后抑制 watcher 事件的窗口：必须 > watcher 的 500ms 防抖，否则抑制不住那一轮 */
export const REPO_CHANGE_SUPPRESS_MS = 1200;
```

**统一闸门**（把现有 `refresh` 的实现体原样搬进 `doRefreshOnce`，新增 `doRefreshLightOnce`）：

```ts
/**
 * 刷新闸门：单飞 + 合并。
 * - 已有刷新在飞 → 只登记「待补跑」与请求档位，并等补跑那轮落地才 resolve（写操作后的等待语义不退化）
 * - 补跑那轮跑**最重的那档请求**：期间来了全量请求，补跑就必须是全量，否则 log 会陈旧
 */
async function withRefreshGate(
  set: (p: Partial<RepoState>) => void,
  get: () => RepoState,
  heavy: boolean,
  run: (heavy: boolean) => Promise<void>,
): Promise<void> {
  if (get().refreshBusy) {
    await new Promise<void>((resolve) =>
      set({
        refreshDirty: true,
        refreshHeavy: get().refreshHeavy || heavy,
        refreshWaiters: [...get().refreshWaiters, resolve],
      }),
    );
    return;
  }
  set({ refreshBusy: true, refreshDirty: false, refreshHeavy: false });
  try {
    do {
      const useHeavy = get().refreshHeavy || heavy;
      set({ refreshDirty: false, refreshHeavy: false });
      await run(useHeavy);
    } while (get().refreshDirty);
  } finally {
    set({ refreshBusy: false });
    // 以下三行之间没有 await，新调用不可能插进来
    const waiters = get().refreshWaiters;
    set({ refreshWaiters: [] });
    waiters.forEach((w) => w());
  }
}
```

两档入口：

```ts
refresh: async () =>
  withRefreshGate(set, get, true, (heavy) =>
    heavy ? doRefreshOnce(set, get) : doRefreshLightOnce(set, get),
),

refreshLight: async () =>
  withRefreshGate(set, get, false, (heavy) =>
    heavy ? doRefreshOnce(set, get) : doRefreshLightOnce(set, get),
),

applyRepoChange: (change) => {
  // 自己刚写完仓库：watcher 那一轮已被写操作自己的 refresh 覆盖
  if (Date.now() - get().lastWriteAt < REPO_CHANGE_SUPPRESS_MS) return;
  if (change.refs || change.head) void get().refresh();
  else void get().refreshLight();
},
```

`doRefreshLightOnce`：只重拉 status（+ stash），不碰 log / refs / summary / remotes：

```ts
async function doRefreshLightOnce(
  set: (p: Partial<RepoState>) => void,
  get: () => RepoState,
): Promise<void> {
  if (!get().meta) return;
  const [status, stashes] = await Promise.all([
    ipc.getStatus().catch(() => null),
    ipc.stashList().catch(() => null),
  ]);
  if (!get().meta) return; // 期间关仓库了
  set({ status: status ?? get().status, stashes: stashes ?? get().stashes });
  pruneViews(set, get);
}
```

`pruneViews(set, get)`：把 `doRefreshOnce` 里现成的三段修剪原样抽出来（工作区选中文件是否还在
→ `reloadWorkDiff` 或收起；`stashView` 条目是否还在；`conflictView` 文件是否还在），两档共用。

`runWrite` 里给抑制窗口打时间戳（**在 git 操作刚落幕时**，不是 finally —— finally 在 refresh 之后，
会把窗口起点推后一个刷新时长）：

```ts
  try {
    const msg = await op();
    set({ lastWriteAt: Date.now() });      // watcher 的事件约 500ms 后到
    get().updateToast(id, { kind: "ok", text: ... });
    await get().refresh();
    return true;
  } catch (e) {
    set({ lastWriteAt: Date.now() });      // 失败也可能写了 .git（冲突留下的 MERGE_HEAD 等）
    get().updateToast(id, { kind: "err", text: await errText(e) });
    return false;
  } finally {
    set({ writeBusy: false });
  }
```

## 4) 测试（`src/stores/repo.test.ts`，打桩 IPC）

- **单飞 + 合并**：让 `getLog` 的 mock 返回一个手动 resolve 的 deferred；连续调用 `refresh()` 3 次
  → 断言 `getLog` 只被调用 **2** 次（1 轮 + 1 轮补跑），且 3 个 promise 都在补跑后 resolve。
- **档位提升**：`refreshLight()` 在飞时调 `refresh()` → 补跑那轮必须是全量（断言 `getLog` 被调用）。
- **分流**：`applyRepoChange({ index: true, refs: false, head: false, worktree: false })` →
  `getLog` **零**调用、`getStatus` 1 次；`applyRepoChange({ refs: true, ... })` → `getLog` 1 次。
- **抑制窗口**：写操作后紧接 `applyRepoChange({ refs: true })` → `getLog` 零额外调用；
  用 `vi.setSystemTime` 把时间推过 `REPO_CHANGE_SUPPRESS_MS` 再来一次 → 有调用。
- **既有用例**：`getBranchSummary` 的 stub 与 `summary` 断言**全部保留**（本票不删该调用）。

**Blocked by:** 01、02（代码不依赖，但「刷新轮数」类验收要在前两票落地后才有意义）

**Status:** ready-for-agent

- [x] `pnpm test` + `pnpm build`（含 tsc）全绿；既有用例语义不变
      → `pnpm test`：**7 files / 169 passed**（基线 164 + 新增 5）；`pnpm build`：`tsc && vite build` 通过（exit 0，仅剩既有的 INEFFECTIVE_DYNAMIC_IMPORT 提示）。既有 164 条一行未改语义，`getBranchSummary` 的 stub 与 `summary` 断言**全部保留**（本票不删该调用）
- [x] 上述四组新用例通过
      → 新增 5 条，见 `src/stores/repo.test.ts` 末段 describe「刷新编排：单飞合并 / 档位 / 分流 / 写后抑制（工单 03）」：单飞+合并（并发 3 次 `refresh()` → `getLog` 恰好 2 次、3 个 promise 都在补跑落地后才 resolve）、档位提升（轻档在飞 + 全量请求 → 补跑那轮重拉 log）、分流（index / worktree 事件零 `getLog` + 1 次 `getStatus`；refs 事件 1 次 `getLog`）、写后抑制（窗口内零额外 `getLog`；`vi.setSystemTime` 推过窗口后生效）、抑制窗口起点（git 操作落幕即开窗：刷新还在飞时 `lastWriteAt > 0`）
- [x] 反向验证有效：删掉抑制判断 → 抑制用例变红；删掉档位提升 → 档位用例变红
      → 两组 RED 原文见 Comments；两次都只红对应用例（`1 failed | 168 passed`），恢复后文件 sha256 与破坏前一致，破坏态从未 `git add`
- [x] `cargo test -- --test-threads=1` 全绿；新增 `classify` 纯函数用例（index / refs / packed-refs / HEAD / objects / 工作区路径各一条）
      → `test result: ok. 74 passed; 0 failed; 1 ignored`（基线 66 + 新增 8）；`watcher::tests`：index / `refs/**` / packed-refs / HEAD / objects+logs+ORIG_HEAD+lock（另含 `.git` 目录自身与空输入）/ 工作区路径 / `merge` 并集
- [ ] 端到端：在仓库根目录改一个文件（触发器）→ 只重拉 status，**不重拉 log**
      （观测：临时在 `doRefreshOnce` / `doRefreshLightOnce` 入口打一行 `console.debug`，走查完删除）
      （控制器联合端到端验收时勾选 —— ledger 裁决 R2）
- [ ] 端到端：做一次写操作（如暂存）→ 只发生 **1** 轮刷新（抑制生效）（观测方式同上）
      （控制器联合端到端验收时勾选 —— ledger 裁决 R2）
- [ ] 端到端：10 万提交夹具下 `Get-Process git` ≥3 并发且窗口不冻结（与 01 的验收合并走一次）
      （控制器联合端到端验收时勾选 —— ledger 裁决 R2）
- [x] Comments 记下两个已知边界：linked worktree 无监听、工作区为 NonRecursive（只有根目录文件）

**Comments**

**执行记录**（PowerShell 7 / Node v22.20.0 / pnpm 12.3.4 / cargo 1.97.1 / git 2.35.1.windows.2）

**代码提交**：`7b3ba8d`（`feat(refresh): repo-changed 携带变更分类 + 尾沿防抖 + 前端单飞合并与写后抑制（工单 03）`）——只含 `src-tauri/src/watcher.rs`、`src/lib/types.ts`、`src/lib/ipc.ts`、`src/stores/repo.ts`、`src/App.tsx`、`src/stores/repo.test.ts`；`commands.rs` / `git.rs` / `lib.rs` 与其它组件一行未动，命令签名、`GitError`、`get_branch_summary` 全部保留。本工单文本随后以 `docs(tickets)` 提交收口（工单要写下代码提交 hash，故拆两个提交）。完整报告（未入 git）：`.superpowers/sdd/ipc-nonblocking/task-03-report.md`。

**实现要点**

- `watcher.rs`：新增 `RepoChange { index, refs, head, worktree }`（`Serialize` + `merge` / `needs_log` / `is_empty`）与纯函数 `classify(root, paths)`；防抖从**前沿**改成**尾沿**（`Pending { change, deadline, armed }` + 单计时线程：窗口内每个新事件把 deadline 往后推，静默 500ms 后一次性 `emit("repo-changed", 累积分类)`）。累积变更 `is_empty()` 时**不发事件** —— 只动 objects / logs / lock 的变更不再触发任何刷新。
- 前端接线：`listenRepoChanged(cb(change))` 带载荷（`listen<RepoChange>("repo-changed", e => cb(e.payload))`）；`App.tsx` 改为 `useRepo.getState().applyRepoChange(change)`（原来那个 `refresh` 选择器随之删除，否则 `noUnusedLocals` 编译不过）。
- `repo.ts`：`refresh()` 原实现体原样搬进 `doRefreshOnce`；三段右栏修剪抽成 `pruneViews(set, get)`（两档共用，调用方先 `set` 再调，函数内读 state 里的最新一份）；新增 `doRefreshLightOnce`（只拉 status + stash）与统一闸门 `withRefreshGate`（单飞 + 合并 + 等补跑那轮落地才 resolve；补跑档位取「发起调用的档位 ∪ 在飞期间最重的请求」，**只升不降**）；新增 `refreshLight` / `applyRepoChange` 两个入口；打戳统一走 `markWrite(set)` 助手（就是 `set({ lastWriteAt: Date.now() })`），在 git 操作刚落幕时调用、**不在 `finally`**（finally 在 refresh 之后，会把窗口起点推后一个刷新时长）。**打戳覆盖范围**（评审 1 轮修正）：不只 `runWrite`（成功 / 失败两支），还包括 6 条**自己会 `refresh()` 的**非 runWrite 写路径 —— `createBranch` / `renameBranchFlow` / `setUpstreamFlow` / `commit` / `remote`（fetch / pull / push）/ `stashRestore`（含其 catch）；**故意不打戳**的是「自己从不 `refresh()`、只靠 watcher 那轮更新」的 `stage` / `unstage`（打戳会把唯一的刷新抑制掉，面板停在上一次的状态）。
- `REPO_CHANGE_SUPPRESS_MS = 1200` 导出常量，注释写明必须 > watcher 的 500ms 防抖。

**验证命令与结果**

```
$ pnpm test                                   # 7 files / 169 passed（基线 164 + 新增 5）
$ pnpm build                                  # tsc && vite build 通过（exit 0）
$ cd src-tauri && cargo test -- --test-threads=1
test result: ok. 74 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 233.83s
```

**反向验证（RED → 恢复后 GREEN）**

```
# ① 删掉 applyRepoChange 里的抑制判断（`if (Date.now() - get().lastWriteAt < REPO_CHANGE_SUPPRESS_MS) return;`）
$ pnpm test
 ❯ src/stores/repo.test.ts (98 tests | 1 failed) 1348ms
   × 写后抑制：写操作落幕后的 watcher 事件不触发额外一轮；窗口过期后才生效 8ms
AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
 Test Files  1 failed | 6 passed (7)      Tests  1 failed | 168 passed (169)

# ② 删掉 withRefreshGate 的档位提升（`refreshHeavy: get().refreshHeavy || heavy` → `false`）
$ pnpm test
 ❯ src/stores/repo.test.ts (98 tests | 1 failed) 1367ms
   × 档位提升：轻档在飞时来全量请求 → 补跑那轮必须是全量（重拉 log） 23ms
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 Test Files  1 failed | 6 passed (7)      Tests  1 failed | 168 passed (169)

# 两次破坏态都用备份文件覆盖恢复（sha256 与破坏前逐字节一致），再跑：
$ pnpm test
 Test Files  7 passed (7)      Tests  169 passed (169)
```

**四个已知边界（本票不修，如实记录）**

1. **linked worktree 下没有外部变更监听**：那里 `root/.git` 是**文件**（内容是 `gitdir: …`），`watcher.watch(root.join(".git"), Recursive)` 会失败，`commands.rs:130` 的 `.ok()` 把错误吞掉 → 该仓库的 `repo_watcher` 直接是 `None`（连工作区那条 watch 也拿不到，因为 `?` 之后的两行都没执行）。既有缺陷、非本票引入；本票的尾沿防抖 / 分类 / 抑制在 linked worktree 上等于「没有 watcher 事件可抑制」。
2. **工作区监听是 `RecursiveMode::NonRecursive`**：只有仓库**根目录下的直接文件**变更会被看到，`src/**` 里的存盘不触发任何事件（git 自己的写操作仍由 `.git` 那条 Recursive 监听覆盖）。故「工作区变更不重拉 log」的收益目前只覆盖根目录文件；改成 Recursive 会显著放大事件量，属另一票的取舍。
3. **`.git/config` 变更现在不发事件**：`classify` 的兜底分支吞掉所有「不是 `index` / `refs/**` / `packed-refs` / `HEAD`」的 `.git/**` 路径（`.git/config`、`.git/hooks/**` 等），而改造前的**前沿**实现是「任何 `.git` 变更都发事件」→ 外部 `git remote add` / `git config` / `branch --set-upstream-to` 不再自动刷新 remotes / identity，要等下一个别的事件（或用户自己触发一次刷新）。控制器裁决：**记录边界、不修**（正确修法要新增一个分类位，超出本票范围）。
4. **新的防抖 / flush 代码没有测试**：工单只要求 `classify` 的纯函数用例，故 `armed` 复位、计时线程单实例互斥、`is_empty` 不发事件这三条只有人工走查（`cargo test` 里 `watcher::tests` 的 8 条全是 `classify` / `merge`）。

**改动范围**：首轮 `7b3ba8d`（`git show --numstat 7b3ba8d`）`src-tauri/src/watcher.rs` +193/−16、`src/stores/repo.ts` +154/−45、`src/stores/repo.test.ts` +141/−2、`src/lib/types.ts` +8、`src/lib/ipc.ts` +3/−2、`src/App.tsx` +1/−2；评审 1 轮 `d506e9e`（`git show --numstat d506e9e`）`src-tauri/src/watcher.rs` +43/−22、`src/stores/repo.test.ts` +28/−0、`src/stores/repo.ts` +23/−2。**未动** `commands.rs` / `git.rs` / `lib.rs` / 其它组件。

**如实披露的三处偏差**

1. 工单代码段里 `watcher.rs` 的 `let root = root.to_path_buf();` 会被 `move` 闭包拿走，外层再 `watcher.watch(root, …)` 既借不到 `&Path`（`watch` 只收 `&Path`）也已是 moved value，**编译不过**。改成三份：`watch_root`（给闭包做 `classify`）、`git_dir`、`worktree`（两个 watch 各借一份），语义不变。
2. `RepoChange::needs_log()` 在 Rust 侧没有调用点（emit 只判 `is_empty`，分流在前端做），为保住 `cargo build` 零 warning 加了 `#[allow(dead_code)]` 并注明「前端按同一语义分流」；Rust 用例仍直接断言它。
3. `src/lib/types.ts` 全文用单引号，新接口按该文件风格写（`ipc.ts` / `repo.ts` / `App.tsx` 按工单片段用双引号）。

**评审 1 轮整改**（1 Important + 2 Minor + 1 文档项；代码提交 `d506e9e`）

评审结论：闸门 / 尾沿加锁 / `pruneViews` 抽取 / 前端契约正确，两组反向验证确实只红对应用例；以下是本轮整改。

1. **Important（plan-mandated）—— 抑制只覆盖 `runWrite`，`commit` / `push` / `pull` / `fetch` 仍是 2 轮**：逐条枚举了 `repo.ts` 里**所有**不在 `runWrite(...)` 参数列表内的变更类 `ipc.*` 调用点，并核对「同一函数随后是否 `get().refresh()`」，结论是**该打戳的正好 6 条**（行号均为本轮改完后）：`createBranch`（675→683）、`renameBranchFlow`（779→783）、`setUpstreamFlow`（919→923）、`commit`（1477→1485）、`remote`（1499→1503）、`stashRestore`（1709→1712，以及 catch 里 1713→1716 那次 refresh 之前）。**故意不打戳**：`stage` / `unstage`（1459 / 1468 之后只 `set({ status })`，从不 refresh —— 打戳会把它们唯一的刷新抑制掉）；`guardDirtyTree` 的 stash 分支（`stashPush` 之后走 `opts.proceed()`，那条 runWrite 自己会打戳）。打戳统一走新助手 `markWrite(set)`（`runWrite` 里那两处也改用它），助手注释写明「只给自己接着会 `refresh()` 的写路径用」。
   **新增两条用例**：① `commit` 之后紧接 `applyRepoChange({ refs: true, … })` → 零额外 `getLog`，`vi.setSystemTime` 推过窗口后才 +1；② `stage` 之后 `lastWriteAt === 0` 且 `applyRepoChange({ index: true, … })` 仍触发 1 次 `getStatus`（把「不许给 stage 打戳」也钉成用例）。**反向验证**：删掉 `commit` 里那行 `markWrite(set)` → ① 变红（原文见下）。
2. **Minor —— 锁中毒会永久掐死外部变更通知**：`pending.lock()` 失败时回调与计时线程都直接 `return`，`armed` 永远停在 `true`。改为 `lock_pending()` 助手（`unwrap_or_else(|e| e.into_inner())`，与 `commands.rs:59` 的写锁同一约定），并把计时线程的创建改成 `thread::Builder::spawn`（返回 `io::Result`）：起不来线程就复位 `armed`，下个事件重新尝试 —— 不再有「`armed` 已置位却没人跑」的窗口。
3. **Minor —— 1200ms 窗口余量只有 ~200ms**：flush 循环原来每轮固定睡 `DEBOUNCE`，emit 最晚可晚一整个防抖周期。改为睡「距 deadline 的剩余时间」（且**不持锁睡**），窗口被推后时只补睡差额 → emit 贴着 deadline 落地（最多晚调度抖动），1200 − 500 的 ~700ms 余量才真正可用；注释写明为什么不是固定睡 DEBOUNCE。
4. **文档项 —— 又记两个已知边界**：见上「四个已知边界」的第 3、4 条（`.git/config` 不再发事件；防抖 / flush 只有人工走查），并修正了首轮 Comments 里「抑制已生效」未加限定的说法。

**本轮验证命令与结果**

```
$ pnpm test                                   # 7 files / 171 passed（基线 164 + 本票 7 条）
$ pnpm build                                  # tsc && vite build 通过（exit 0）
$ cd src-tauri && cargo test -- --test-threads=1
test result: ok. 74 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 293.34s
```

**本轮反向验证 RED → 恢复后 GREEN**

```
# 删掉 commit 里那行 markWrite(set)
$ pnpm test
 ❯ src/stores/repo.test.ts (100 tests | 1 failed) 1414ms
   × 写后抑制覆盖非 runWrite 的写路径：commit 落幕后的 refs 事件不再触发第二轮 9ms
AssertionError: expected 0 to be greater than 0
 Test Files  1 failed | 6 passed (7)      Tests  1 failed | 170 passed (171)

# 用备份文件覆盖恢复（sha256 与破坏前一致：B44E4B55885D23B02E50D97BE7C3F4C2ED6DCA6D1B2062B5B97372D9633EDAFE）
$ pnpm test
 Test Files  7 passed (7)      Tests  171 passed (171)
```

**端到端观测口径（留给控制器联合验收）**：验收「做一次写操作 → 只发生 1 轮刷新」请用**提交（commit）**而不是暂存（stage）—— `stage` 自己从不 `refresh()`，它的「1 轮」来自 watcher，无论抑制是否生效都看起来是 1 轮；`commit` 自带一轮全量刷新，抑制生效时 watcher 那轮不再叠加（本票用例 ① 钉的就是这条）。临时 `console.debug` 观测点建议打在 `doRefreshOnce` / `doRefreshLightOnce` 入口。
