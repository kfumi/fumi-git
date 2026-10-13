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

- [ ] `pnpm test` + `pnpm build`（含 tsc）全绿；既有用例语义不变
- [ ] 上述四组新用例通过
- [ ] 反向验证有效：删掉抑制判断 → 抑制用例变红；删掉档位提升 → 档位用例变红
- [ ] `cargo test -- --test-threads=1` 全绿；新增 `classify` 纯函数用例（index / refs / packed-refs / HEAD / objects / 工作区路径各一条）
- [ ] 端到端：在仓库根目录改一个文件（触发器）→ 只重拉 status，**不重拉 log**
      （观测：临时在 `doRefreshOnce` / `doRefreshLightOnce` 入口打一行 `console.debug`，走查完删除）
- [ ] 端到端：做一次写操作（如暂存）→ 只发生 **1** 轮刷新（抑制生效）（观测方式同上）
- [ ] 端到端：10 万提交夹具下 `Get-Process git` ≥3 并发且窗口不冻结（与 01 的验收合并走一次）
- [ ] Comments 记下两个已知边界：linked worktree 无监听、工作区为 NonRecursive（只有根目录文件）

**Comments**

（执行时回填：观测方式与观测值、commit hash）
