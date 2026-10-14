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
- [x] 端到端：在仓库根目录改一个文件（触发器）→ 只重拉 status，**不重拉 log**
      （观测：临时在 `doRefreshOnce` / `doRefreshLightOnce` 入口打一行 `console.debug`，走查完删除）
      （控制器联合端到端验收时勾选 —— ledger 裁决 R2）
      → 控制器联合端到端验收（ledger 裁决 R2）：夹具根目录写入 `probe-e2e.txt`（文件 CreationTime **22:22:00.597**）→ **0.63 s** 后该 phase 的 trace 里只有 2 条命令：`stash list '--format=%gd%x1f%gs%x1f%ct'`（**22:22:01.229077**，perf 0.0025 s）与 `status --porcelain=v2 --branch -z`（**22:22:01.248655**，perf 0.0095 s）——**`git log` 计数 = 0**（该文件全文只有这 2 条命令，`for-each-ref` / `remote` / `config` 同样为 0）。两条相隔 19 ms = `doRefreshLightOnce`（`repo.ts:567` 的 `Promise.all([getStatus, stashList])`）的并行派发。原始文件：`<PI_SCRATCH_DIR>\e2e\trace-02-light.log`（4 行 / 2 条命令）、`perf-02-light.log`。
      → 如实记录：轻档刷新 = **status + stash**（与本票实现节的 `doRefreshLightOnce` 一致，stash 是既有的一并重拉），判据的绑定意图是「**不重拉 log**」——这一条成立。
- [x] 端到端：做一次写操作（如暂存）→ 只发生 **1** 轮刷新（抑制生效）（观测方式同上）
      （控制器联合端到端验收时勾选 —— ledger 裁决 R2）
      → 控制器联合端到端验收（ledger 裁决 R2）：trace 里 `commit --quiet -F -` 确实执行（**22:22:44.793840**），随后 **`git log` 计数 = 1**（**22:22:45.221030**），同一轮 = status ×2（45.288 / 45.290）/ stash（45.344）/ remote（45.374）/ config ×2（45.413 / 45.560）/ for-each-ref（45.436）——**恰好 1 轮全量**；其后**无第二轮**：该 trace 的下一条记录在 **22:25:19.730**（间隔 154 s，远超判据的 6 s）。落地核对（独立于证据汇总文件）：夹具 `.git\logs\HEAD` reflog 记 `46c033519… → 135eb78eaa4bb614df3570742887201d558d360b`（unix 1791901364 = **2026-10-13 22:22:44 +08:00**，消息 `e2e: 验证写操作只触发一轮刷新`）。原始文件：`<PI_SCRATCH_DIR>\e2e\trace-03-commit.log`（33 行 / 16 条命令）。
      → **与工单措辞的偏差（如实记录）**：工单原文举例「如暂存」，但按 ledger 的 Task 03 评审裁定，`stage` / `unstage` **自己从不 `refresh()`**（`repo.ts:1460-1467` 只有 `ipc.stage` + `ipc.getStatus()`），其唯一刷新来自 watcher，抑制生效与否都看起来是 1 轮、**无法用来观测抑制** → 故改用**提交**（`repo.ts:1480-1488`：`ipc.commit` → `markWrite` → `refresh`，自带一轮全量）。暂存路径「不打戳」由单测钉住（`repo.test.ts`「不许给 stage 打戳」用例）。
      → 旁证（同一 trace 文件内）：22:25:19.730 的 `git add -- probe-e2e.txt` 之后，22:25:20.367 `status` + 20.403 `stash list`（**0 条 `log`**）即 watcher 的 index 事件驱动的轻档一轮（`stage` 自己在 19.886 的那条 `status` 来自 `repo.ts:1463`）——说明本会话 watcher 确实在发事件，「无第二轮」不是「watcher 哑掉」造成的假象。
- [x] 端到端：10 万提交夹具下 `Get-Process git` ≥3 并发且窗口不冻结（与 01 的验收合并走一次）
      （控制器联合端到端验收时勾选 —— ledger 裁决 R2）
      → 控制器联合端到端验收（ledger 裁决 R2，与 01 的验收合并走一次）：`sample.log` 里打开夹具那一轮的窗口（`ts_ms` 1713–2647 ≈ 22:19:31.8–32.7）**峰值 `gits` = 11 → 应用自有 10 ≥ 3** ✓，与 `trace-01-open.log` 的 10 条应用命令（`rev-parse` / `symbolic-ref` + 8 条刷新命令）+ 1 个无关基线进程吻合；该轮 8 条刷新命令起于 32.197–32.583、log 收于 32.695（perf 0.5009 s），即同时派发。**不冻结**：`fumi_responding` 列在整个应用存活段只有 `True` —— 控制器最终读数 **624,303/624,303 条**（采样器已由控制器停止；其后的 5,194 行是 `gone`，因应用在全部验收场景结束很久之后才退出，见 Comments 的「保留意见」）。原始文件：`<PI_SCRATCH_DIR>\e2e\sample.log`、`trace-01-open.log`、`perf-01-open.log`。
      → 「应用自有 = 总数 − 1」口径的独立核对：本机常驻 1 个与本应用无关的僵留 `git.exe`（pid 17260，09:25:10 启动）；核对时 `Get-Process -Name git` = 1，且全部样本的最小值也是 1 ✓。
      → 两点保留（如实记录）：① 持续负载段（`trace-04-pagination.log` 的 23 条 `log`，其中前 19 条落在 22:25:23.216→33.130 ≈ 10 s 内）该窗口 `gits` = **3（应用自有 2）**，低于 3 —— 即「≥3 并发」由**打开那一轮的扇出（应用自有 10）**满足，不是分页负载段；② **原生窗口拖动未实测**（走查期间会话锁定，真实鼠标输入无法投递），`Responding=True` 是该项的标准客观代理（负载期间 UI 输入被处理的 DOM 侧证据见证据汇总第 5 节，我未重新驱动 UI）。
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

1. **Important（plan-mandated）—— 抑制只覆盖 `runWrite`，`commit` / `push` / `pull` / `fetch` / `merge` 仍是 2 轮**：枚举 `repo.ts` 里**所有**不在 `runWrite(...)` 参数列表内的变更类 `ipc.*` 调用点，并核对「同一函数随后是否 `get().refresh()`」。**评审 2 轮更正**：首轮这份清单漏了 `mergeUpstreamFlow`（`ipc.mergeRef` 不在任何 runWrite 里，成功与 catch 两支都自己 refresh），还把 `writeWorktreeFile` 误记成「在 runWrite 里」。机械重做（TypeScript AST 遍历，见「评审 2 轮整改」的完整表格）后结论是**该打戳的 7 条**、**故意不打戳的 4 条**。7 条打戳点（行号为本轮改完后）：`createBranch`（675→683）、`renameBranchFlow`（779→783）、`setUpstreamFlow`（919→923）、`commit`（1480→1488）、`remote`（1502→1506，fetch / pull / push）、`mergeUpstreamFlow`（1642→1645，catch 支 1649）、`stashRestore`（1714→1717，catch 支 1721）。**故意不打戳**：`stage` / `unstage`（1462 / 1471 之后只 `set({ status })`，从不 refresh —— 打戳会把它们唯一的刷新抑制掉）、`applyConflictBlock` 的 `writeWorktreeFile`（1854，只改 `conflictView`）、`guardDirtyTree` 的 stash 分支（395，随后走 `opts.proceed()`，那条 runWrite 自己打戳）。打戳统一走新助手 `markWrite(set)`（`runWrite` 里那两处也改用它），助手注释写明「只给自己接着会 `refresh()` 的写路径用」。
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

**评审 2 轮整改**（1 Important 未闭环 + 1 新 Minor + 1 顺带 Minor；代码提交 `716a6be`）

1. **Finding 1 补闭环 —— `mergeUpstreamFlow` 漏打戳**：`ipc.mergeRef`（`mergeUpstreamFlow` 的对话框 IIFE 内，1642）不在任何 `runWrite` 里，成功支 1645 与 catch 支 1649 都自己 `refresh()`，而整个 IIFE（1639-1658）没有 `markWrite` —— 一次 `git merge` 改 refs / HEAD / index / 工作区，watcher 的 `{refs:true}` 事件不被抑制，`applyRepoChange` 会再发一轮全量刷新。已补两处戳（成功支紧随 `ipc.mergeRef` 之后、catch 支在 `asGitError` 与 refresh 之前，与 `stashRestore` 同构）。
   **机械重做枚举**（TypeScript AST：找出所有 `ipc.<x>(...)`，判断是否落在某个 `runWrite(...)` 实参树内、最内层函数与所在 store 方法是否含 `refresh()` / `markWrite`）：`repo.ts` 共 81 个 `ipc.*` 调用点，48 个变更类，其中 **35 个在 `runWrite(...)` 内**（由 runWrite 打戳），**13 个不在**（去重后 11 处代码位置，因 `remote` 一行三选一算 3 条）。13 条的完整判定如下（行号为本轮改完后）：

| # | 调用点 | 所在位置 | 自己 `get().refresh()`？ | 已打戳？ |
| --- | --- | --- | --- | --- |
| 1 | `ipc.stashPush` 395 | `guardDirtyTree` 的 stash 动作（fn 393） | 否（随后走 `opts.proceed()`，那条 runWrite 打戳） | 否 ✓ |
| 2 | `ipc.createBranch` 675 | `createBranch` | 是（683） | **是** ✓ |
| 3 | `ipc.renameBranch` 779 | `renameBranchFlow` 对话框动作（fn 775） | 是（783） | **是** ✓ |
| 4 | `ipc.setUpstream` 919 | `setUpstreamFlow` 对话框动作（fn 916） | 是（923） | **是** ✓ |
| 5 | `ipc.stage` 1462 | `stage` | 否（只 `set({ status })`） | 否 ✓ |
| 6 | `ipc.unstage` 1471 | `unstage` | 否 | 否 ✓ |
| 7 | `ipc.commit` 1480 | `commit` | 是（1488） | **是** ✓ |
| 8 | `ipc.fetch` / `pull` / `push` 1502 | `remote` | 是（1506） | **是** ✓ |
| 9 | `ipc.mergeRef` 1642 | `mergeUpstreamFlow` 的 IIFE（fn 1639） | 是（成功 1645 / catch 1649） | **是**（本轮补） ✓ |
| 10 | `ipc.stashApply` 1714 | `stashRestore` | 是（成功 1717 / catch 1721） | **是** ✓ |
| 11 | `ipc.writeWorktreeFile` 1854 | `applyConflictBlock` | 否（只改 `conflictView`） | 否 ✓ |

   即：**「自己 refresh」的 9 条全部有戳（9/9），「不 refresh」的 4 条全部没有戳（4/4）**；`runWrite` 内的 35 条由 runWrite 统一打戳。首轮把 `writeWorktreeFile` 归进「runWrite 内」、把 `mergeUpstreamFlow` 整个漏掉，本轮已更正。
2. **新 Minor —— 起线程失败会把这一轮变更搁死**：`spawn_flush` 失败时只复位 `armed`，`deadline = Some(...)` 与累积的 `change` 留在原地而没有计时器 —— 若之后没有新事件，这次变更永远不发、UI 停在旧状态。改为**就地发出**（`mem::take` 累积分类、清 `deadline` / `armed`、放锁后 `emit`；前置防抖的老实现也是从这个回调里 emit），并留一行注释说明原因。
3. **顺带 Minor —— 抑制窗口跨仓库泄漏**：`lastWriteAt` 从未在换仓库时复位（只在类型 135 / 打戳 428 / 初值 647 / 判定 1347 出现）。A 仓库写完 1200ms 内打开 B 仓库，B 的第一个 watcher 事件会被压掉。已在 `openRepo` 的状态重置块（1262-1263）与 `closeRepo`（1305）各加一行 `lastWriteAt: 0`（各带一句注释），不动其它结构。
   **新增三条用例**：① `mergeUpstreamFlow` 成功支（合并后 `lastWriteAt > 0`、`{refs:true}` 事件零额外 `getLog`、推过窗口后 +1）；② `mergeUpstreamFlow` **catch 支**（失败也打戳 + 抑制生效 —— 这就是「带 catch 刷新的旁路路径」的覆盖）；③ 换仓库清窗口（A 仓库 commit 打上窗口 → `openRepo` 到 B 仓库后 `lastWriteAt === 0`，B 的第一个事件照常刷新）。

**评审 2 轮验证命令与结果**

```
$ pnpm test                                   # 7 files / 174 passed（基线 164 + 本票 10 条）
$ pnpm build                                  # tsc && vite build 通过（exit 0）
$ cd src-tauri && cargo test -- --test-threads=1
test result: ok. 74 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 249.35s
```

**评审 2 轮反向验证（RED → 恢复后 GREEN）**

```
# ① 删掉 mergeUpstreamFlow 的两处 markWrite（成功支 + catch 支）
$ pnpm test
 ❯ src/stores/repo.test.ts (103 tests | 2 failed) 1461ms
   × 写后抑制覆盖 mergeUpstreamFlow：合并落幕后的 refs 事件不再触发第二轮 27ms
   × 写后抑制也覆盖合并失败那支：catch 里的 refresh 之前同样打戳 1ms
AssertionError: expected 0 to be greater than 0   # 两条都是 lastWriteAt 没打上
 Test Files  1 failed | 6 passed (7)      Tests  2 failed | 172 passed (174)

# ② 删掉 openRepo 的 lastWriteAt 复位
$ pnpm test
 ❯ src/stores/repo.test.ts (103 tests | 1 failed) 1477ms
   × 换仓库清抑制窗口：A 仓库刚写完，开 B 仓库后的第一个事件不被压掉 13ms
AssertionError: expected 1791899227710 to be +0 // Object.is equality
 Test Files  1 failed | 6 passed (7)      Tests  1 failed | 173 passed (174)

# 两次都用备份文件覆盖恢复（sha256 = BFCEC604256D37E0D8E13F16B79D53015CF24BFF6492F2668928549D75549D1C，与破坏前一致）
$ pnpm test
 Test Files  7 passed (7)      Tests  174 passed (174)
```

**评审 2 轮改动范围**（`git show --numstat 716a6be`）：`src/stores/repo.ts` +5/−0、`src/stores/repo.test.ts` +53/−0、`src-tauri/src/watcher.rs` +10/−2。**未动** `commands.rs` / `git.rs` / `lib.rs`；`refresh` 签名与既有用例语义不变。

**联合端到端验收（控制器，2026-10-13）**

本票三条端到端项按 ledger 裁决 R2 推迟到「联合端到端验收」（代码早已落地：`7b3ba8d` / `d506e9e` / `716a6be`，四票 00–03 全绿于 `b09a1de`）；控制器已完成观测，本节为回填。

**观测方法（零代码改动）**

- 启动应用**之前**在**进程环境**里设 `GIT_TRACE=<file>` 与 `GIT_TRACE_PERFORMANCE=<file>`：每个 git 子进程向同一文件追加 `trace: built-in: git <args>`（启动）与 `performance: N s: git command: git.exe …`（结束 + 耗时）。`spawn_git` 不改子进程环境，故这两行**只可能来自应用派生的 git** —— 工单原本建议的「临时在 `doRefreshOnce` / `doRefreshLightOnce` 入口打一行 `console.debug`、走查完删除」因此**不需要**（观测点更靠下，且一行代码未动）。
- **进程 / 可交互性证据**：后台 PowerShell 循环每 ~40 ms 记录 `(Get-Process -Name git).Count` 与 `(Get-Process -Name fumi-git).Responding`，写 `sample.log`（CSV `ts_ms,gits,fumi_pids,fumi_responding`；`ts_ms` 以采样起点为 0，本会话起点 ≈ **22:19:30.1**，由「峰值时刻 ↔ trace 时间戳」互校，误差 < 0.2 s）。
- 夹具 `<PI_SCRATCH_DIR>\perf-repo-script`：脚本生成、10 万提交、refs = main + feat。每条断言都以 **git 级 trace** 为准，**不以 DOM 自述为准**；原始文件在 `<PI_SCRATCH_DIR>\e2e\`（`trace-01-open` / `trace-02-light` / `trace-03-commit` / `trace-04-pagination`、`perf-01-open` / `perf-02-light` / `perf-04-pagination`、`sample.log`）。

**方法披露（必须）：UI 交互经应用自身 WebView2 远程调试端口驱动**

- 走查期间**当前会话处于锁定状态**（`LockApp.exe` + `LogonUI.exe` 占前台，`WScript.Shell.AppActivate` 返回 True 但前台窗口不变）→ 真实鼠标 / 键盘输入无法投递。
- 故 UI 交互改为经**应用自身 WebView2 的远程调试端口**（启动时设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）用 `Runtime.evaluate`（`userGesture: true`）驱动 —— 走的是**同一批 DOM 事件处理器与同一条 IPC 路径**（`ipc.*` → Tauri 命令 → `spawn_git`）。
- **未覆盖**：原生窗口拖动（需要真实鼠标）未实测，`Responding=True` 是「不冻结」的标准客观代理。

**三条实测数字（与勾选项一一对应）**

1. `03:312` 外改文件 → 只重拉 status（`trace-02-light.log` / `perf-02-light.log`）：夹具根目录 `probe-e2e.txt` 写入（CreationTime 22:22:00.597）→ **0.63 s** 后仅 2 条命令 `stash list`（22:22:01.229077）+ `status --porcelain=v2 --branch -z`（22:22:01.248655），**`git log` = 0**；两条相隔 19 ms = `doRefreshLightOnce` 的并行派发。
2. `03:315` 写操作 → 只 1 轮（`trace-03-commit.log`）：`commit --quiet -F -` 22:22:44.793840 → **`git log` = 1**（22:22:45.221030）+ 同一轮 status ×2 / stash / remote / config ×2 / for-each-ref（45.288 → 45.560）；其后 **154 s** 内无第二轮（判据 6 s）。落地：reflog `135eb78eaa4bb614df3570742887201d558d360b`（22:22:44 +08:00）。**偏差**：工单举例「暂存」，按评审裁定改用**提交** —— `stage` 自己从不 `refresh()`（`repo.ts:1460-1467`），其唯一刷新来自 watcher，看起来永远是 1 轮、观测不了抑制；暂存「不打戳」由单测钉住。
3. `03:317` 并发与不冻结（`sample.log` + `trace-01-open.log`）：打开 10 万夹具那一轮（`ts_ms` 1713–2647）**峰值 gits = 11 → 应用自有 10 ≥ 3** ✓；`fumi_responding` 列去重值只有 `True`。持续负载段（`trace-04-pagination.log` 的 23 条 `log`）窗口 gits = 3（应用自有 2），低于 3 ——「≥3」由打开轮的扇出满足。

**本节保留意见（未能从原始文件证实的部分，如实记录）**

- `sample.log` 的最终状态（控制器已停止采样器）：全文件 **629,497 行 / 跨度 39,318,023 ms**；应用存活段（`ts_ms` ≤ 38,980,655）**624,303 行 `fumi_responding` 全部为 `True`**，`ts_ms` = 38,980,734 起 5,194 行为 `gone`（应用 pid 41680 退出 —— 退出点在全部验收场景结束之后：证据窗口只到 `ts_ms` ≈ 542,406）⇒「N/N 条样本全 `True`」的 N 从此确定，不随读取时刻变化。全文件最大 `gits` = 17，出现在 `ts_ms` 485127 ≈ 22:27:35 的切换 / 提交窗口（属 01 的场景），打开轮的峰值是 11（应用自有 10）。
- 证据汇总文件记的外部写入时刻 **22:22:00.589** 在任何原始 trace 里都不存在；我用夹具文件 `CreationTime` 核到 **22:22:00.597**（差 8 ms，同一次写入）。
- 「抑制生效」是**推断而非直接观测**（trace 只能证明「没有第二轮」）。旁证两条：① 同一 trace 文件里 `git add`（22:25:19.730）之后确实出现 watcher 驱动的轻档一轮（status 20.367 + stash 20.403，0 条 `log`）→ 本会话 watcher 确实在发事件；② `commit` 路径的 `markWrite`（`repo.ts:1482`）在 refs 事件（~500 ms 后到）之前开窗 1200 ms。
- 提交那一轮没有对应的 `GIT_TRACE_PERFORMANCE` 文件（无 `perf-03`），故该轮只有时间戳、没有单命令耗时；轮数判据不受影响。
- 证据汇总文件里「该负载窗口 180 条样本 maxGits=3」一条：**已按最终文件复算** —— 交互窗口（`ts_ms` 560000–582000）共 **481 条样本、`gits` ∈ {1,2,3}、全部 `True`**；原窗口内另见 `gits`=4/5 的样本（`ts_ms` 363347–363472 ≈ 22:25:33.4–33.5，属 22:25 的持续负载段、不是本次交互段）—— 与证据汇总的「180 条」不一致纯属**窗口边界定义不同**，结论（≥3 并发 + 全 `True`）不变。「UI 侧佐证：应用随即把该文件显示为『未暂存 A probe-e2e.txt』」一条仍属 DOM 侧观察，未重新驱动 UI 复核。
