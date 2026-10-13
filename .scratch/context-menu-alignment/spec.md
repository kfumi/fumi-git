Status: needs-triage

# Spec：FumiGit 第三阶段 — 右键菜单全量对齐（分支 · 远程分支 · 提交）

> 来源：2026-10-11 与用户的对齐会话。用户提供同类客户端三份右键菜单截图（本地分支 / 远程分支 / 提交），
> 要求「按他描述的功能对齐，FumiGit 特有的菜单保留」。本 spec 的四个关键决策由用户逐条确认（见下），
> 其余由 agent 按推荐方案代持并在 Implementation Decisions 中标注，可随时推翻。
>
> **取代关系**：本 spec 取代 `.scratch/daily-write-path/spec.md` 的决策 #12（不做 detached HEAD 迁出）
> 与「rebase / tag 后置」条；旧 spec 文本不改写，以本 spec 为准。

## 用户确认的四个决策

1. **「修改提交信息」本批只做 HEAD**（`git commit --amend`），非 HEAD 提交该项禁用并标「仅 HEAD」；任意提交 reword 在本 spec 内单开后续工单。
2. **检出该修订（detached HEAD）推翻旧决策**：可检出、可提交、可 stash；推送/合并/变基等需分支的操作禁用并引导「从此处新建分支」；脏树仍走既有三处选择拦截框。
3. **「与 HEAD 比较」复用右栏详情面板**（新增「比较」模式，不新开弹框）。
4. **术语改用对方措辞**：检出 / 拣选 / 反转提交（取代迁出 / 摘取 / 还原），并同步修订 ui-spec 术语条。

## Problem Statement

FumiGit 第二阶段结束时，「看图谱 → 干活」的主路径已经闭环，但**右键菜单的信息密度与同类客户端差距明显**：
侧栏的远程分支根本没有右键菜单（点击只定位 tip），本地分支菜单缺上游管理、复制、推送/抓取入口，
提交菜单缺复制修订号/提交信息、与 HEAD 比较、检出该修订、新建标签、修改提交信息。

更具体的三处真实缺陷：

1. **本地分支的「新建分支…」基于 HEAD 而不是右键的那个分支**——用户按「从此处新建分支」的心智操作会建错起点。
2. **远程分支是死胡同**：看不到菜单，也无法从远程分支直接开一个跟踪分支开始干活。
3. **`git rebase` 完全没有入口**，用户整理本地提交仍必须回终端；而 rebase 冲突后终端也是唯一出口。

对齐之后，三份菜单在「有哪些动作」这一层与同类客户端一致，FumiGit 特有项（提交菜单里按 ref 动态长出的
检出/合并项、stash 菜单、工作区文件菜单、多远程推送分裂按钮、冲突解决入口）全部保留。

## Solution

三份右键菜单按同类客户端的动作集重排并补齐能力：本地分支 11 项、远程分支 8 项（菜单为新建）、
提交 11 项固定项（另加按提交挂的本地分支动态出现的 0–2 项）。
菜单项构造从组件里抽出成纯函数模块 `src/lib/menus.ts`，三份菜单共用同构项（检出、从此处新建分支、
合并到当前分支、变基、复制分支名），因此禁用规则与文案只有一处定义、可被 vitest 直接断言。

后端按既有三层同步补 **8 个新命令 + 4 处既有契约扩展**（含 `fetch` 带参、删除远程分支、set/unset upstream、新建标签、
`switch --detach`、`commit --amend`、`git rebase` 及其继续/跳过/中止、范围比较）。
`git rebase` 作为第四种「进行中的操作」接入既有冲突视图与横幅设施，冲突解决出口与本阶段已有的
merge / cherry-pick / revert 完全一致，比同类客户端多一个「跳过本次提交」。

## User Stories

**本地分支菜单（右键侧栏分支行）**

1. 作为开发者，我想右键任意本地分支「检出」（当前分支该项禁用并标「当前分支」），以便切过去继续工作。
2. 作为开发者，我想「从此处新建分支…」以**该分支的 tip** 为起点（而不是当前 HEAD），以便按分支位置思考时不必先切过去。
3. 作为开发者，我想「合并到当前分支…」（当前分支该项禁用），以便把别的分支合进来。
4. 作为开发者，我想「将当前分支变基到此分支…」（当前分支该项禁用），以便把本地提交整理到最新基线上。
5. 作为开发者，我想「重命名…」「删除…」（当前分支不可删），以便管理分支生命周期。
6. 作为开发者，我想「设置上游分支…」选择一个远程分支作为上游；已有上游时该项禁用并标「已有 upstream」，以便本地分支能直接 push。
7. 作为开发者，我想「取消上游关联」（无上游时禁用），以便解除一个关联错的远程分支。
8. 作为开发者，我想「复制分支名」，以便把分支名粘到终端或工单里。
9. 作为开发者，我想「推送」把该分支推到它的上游远程同名分支；该分支没有上游时弹出「建立上游关联并推送」对话框（复用既有表单，目标分支为右键的那个分支而非当前分支），以便非当前分支也能推。
10. 作为开发者，我想「抓取」只抓该分支对应的远程；无上游时退化为全量抓取，以便不用为了一个远程等全部远程。

**远程分支菜单（右键侧栏远程分支行；现无菜单）**

11. 作为开发者，我想「检出」远程分支：创建同名本地分支并跟踪它、然后迁出；本地已有同名分支时该项禁用并提示走本地分支菜单，以便从远程分支直接开工。
12. 作为开发者，我想「从此处新建分支…」，以便以远程分支的 tip 为起点开新分支。
13. 作为开发者，我想「合并到当前分支…」「将当前分支变基到此分支…」，以便直接消费远程分支。
14. 作为开发者，我想「删除远程分支…」（危险项 + 二次确认），以便清理已合入的远程分支。
15. 作为开发者，我想「复制分支名」复制 `origin/feat/x` 全名，以便写 refspec 时不手打。
16. 作为开发者，我想「推送」把同名本地分支推到该远程；本地无同名分支时该项禁用，以便补一次显式推送。
17. 作为开发者，我想「抓取」只抓该远程，以便刷新这一个远程的远程分支列表。

**提交菜单（右键历史提交行）**

18. 作为开发者，我想「显示差异」选中该提交并确保右栏详情打开（右栏此前被关掉时也生效），以便在不移动鼠标的情况下看到改动。
19. 作为开发者，我想「复制修订号」（完整 hash，右侧 hint 显示短号），以便把提交 id 交出去。
20. 作为开发者，我想「复制提交信息」（完整 message = subject + body，按需拉取），以便在工单/聊天里引用。
21. 作为开发者，我想「与 HEAD 比较」，在右栏看到 HEAD 与该提交的范围 diff（文件列表 + 统一 patch）；该提交就是 HEAD 时禁用，以便确认某处改动与自己当前工作的差异。
22. 作为开发者，我想「检出该修订」进入分离 HEAD（hint 标 detached）；该提交已是 HEAD 时禁用，以便临时查看历史状态。
23. 作为开发者，我想「从此处新建分支…」，以便把历史里的某个点变成工作起点（既有能力，位置对齐到对方菜单）。
24. 作为开发者，我想「新建标签…」输入名称与可选备注（有备注即附注标签），以便给发布点打标。
25. 作为开发者，我想「拣选…」（cherry-pick）与「反转提交…」（revert），以便搬运与撤销提交（既有能力，术语改词）。
26. 作为开发者，我想「将当前分支重置到此处…」（危险项，保留软/混合/硬三种模式的选择），以便撤销本分支上尚未推送的错误提交。
27. 作为开发者，我想「修改提交信息…」改写 HEAD 提交的信息，对话框预填当前信息；非 HEAD 提交该项禁用并标「仅 HEAD」，以便修正写错的提交信息而不改写更早的历史。
28. 作为开发者，我仍想在第一组看到按提交上挂的 ref 动态长出的「检出到 \<分支\>」「合并 \<分支\> 到当前分支…」，以便按提交位置操作（FumiGit 特有，保留）。

**分离 HEAD 的状态表达与安全边界**

29. 作为开发者，分离 HEAD 时我想在侧栏「分支」区顶部看到 `HEAD（分离）→ <短号>` 状态行并可点击定位，以便知道自己不在任何分支上。
30. 作为开发者，分离 HEAD 时我想提交与 stash 照常可用，以便先看后决定；提交成功后我想看到一句提示「提交未挂在任何分支上，建议『从此处新建分支』」。
31. 作为开发者，分离 HEAD 时推送/合并/变基等需要分支的操作我想看到禁用并附「先从此处新建分支」的提示，以便不会被 git 的报错绕晕。
32. 作为开发者，检出该修订前若工作区脏，我想先看到既有的三选拦截框（带着改动检出 / stash 后检出 / 取消），以便不会无感丢工作。

**变基**

33. 作为开发者，我想在分支菜单里「将当前分支变基到此分支…」，确认框显示「把 \<当前分支\> 变基到 \<目标\>」并说明本地提交会被重写，以便知情后再执行。
34. 作为开发者，变基产生冲突时我想落入与合并相同的冲突解决视图（含未合入文件清单），以便用同一套心智处理。
35. 作为开发者，变基冲突时我想有「继续变基」「跳过本次提交」「中止变基」三个出口，以便逐提交推进或整段反悔。
36. 作为开发者，变基成功后我想看到刷新后的图谱与分支状态；若该分支已推送过，我想在提示里被告知需要 force push（本批不提供），以便知道下一步。
37. 作为开发者，工作区脏时我想被拦下并提示「stash 后变基」，以便变基不会因为脏树半途失败。

**通用**

38. 作为开发者，所有新写操作执行中我想看到进行中反馈并防重复触发（沿用既有 runWrite），以便不会并发发起两个 git 写操作。
39. 作为开发者，所有新操作失败时我想看到可读中文错误（沿用结构化 GitError 规整），以便知道下一步做什么。
40. 作为开发者，「复制」类动作成功后我想看到一句 toast（如「已复制分支名」），以便确认真的复制到了。

## Implementation Decisions

### 菜单构建层

- 新增 **`src/lib/menus.ts`**（纯函数，无 React、不直接调 store）。导出：
  - `branchMenu(target: BranchTarget, actions: MenuActions): MenuItem[]`
  - `remoteMenu(target: RemoteTarget, actions: MenuActions): MenuItem[]`
  - `commitMenu(target: CommitTarget, actions: MenuActions): MenuItem[]`
- 三份菜单同构项由共享内部构造函数产出（检出 / 从此处新建分支 / 合并到当前分支 / 变基 / 复制），禁用规则只在那一处。
- 组件只负责：把 store 动作铺成 `MenuActions`、`contextmenu` 事件里记 `{x, y, target}`、渲染 `<ContextMenu>`。`ContextMenu` 基元本身不改。
- 组序沿用 ui-spec §菜单条目组织：`移动引用 → 派生改动 → 破坏性`，破坏性项必须 `danger` 且沉到末组；`…` 表示后续有对话框；git 术语走右侧 `hint` 灰字。

### 三份菜单的最终形态

**本地分支（11 项）**

```
检出                     hint: checkout（当前分支：禁用 + hint 当前分支）
从此处新建分支…          起点 = 该分支 tip（修正现有基于 HEAD 的错误）
合并到当前分支…           hint: merge（当前分支：禁用）
将当前分支变基到此分支…   hint: rebase（当前分支：禁用）
────
重命名…
设置上游分支…            已有 upstream：禁用 + hint 已有（要换先「取消上游关联」）
取消上游关联             无 upstream：禁用
删除…                    danger（当前分支：禁用）
────
复制分支名
推送                     有上游 → `push <上游远程> <分支>`；无上游 → 弹「建立上游关联并推送」
抓取                     有上游 → 抓取该远程；无上游 → 全量抓取
```

**远程分支（8 项，菜单为新功能）**

```
检出                     创建同名本地跟踪分支并迁出；本地已有同名：禁用 + hint
从此处新建分支…
合并到当前分支…
将当前分支变基到此分支…
────
删除远程分支…            danger + 二次确认
────
复制分支名               复制 <remote>/<branch> 全名
推送                     把同名本地分支推到该远程；无同名本地分支：禁用
抓取                     抓取该远程
```

**提交（11 项固定 + 动态 ref 组）**

```
[动态] 检出到 <分支> / 合并 <分支> 到当前分支…   ← FumiGit 特有，按提交挂的本地分支出现
显示差异
复制修订号               hint: 短号
复制提交信息
────
与 HEAD 比较             HEAD 自身：禁用
检出该修订…              hint: detached；HEAD 自身：禁用
从此处新建分支…
新建标签…
────
拣选…                    hint: cherry-pick
反转提交…                hint: revert
将当前分支重置到此处…    danger（保留三模式对话框）
修改提交信息…            非 HEAD：禁用 + hint 仅 HEAD
```

### IPC 与后端契约（三层同步：`commands.rs` → `lib.rs` 注册 → `ipc.ts` + `types.ts`）

| 命令 | 实现 | 备注 |
| --- | --- | --- |
| `list_refs`（扩展） | `REF_FORMAT` 加上游字段 | `RefEntry.upstream: string \| null`，供设置/取消上游的禁用态；远程 ref 与标签为 `null` |
| `fetch_remote(remote?)` | 无参 = 既有 `fetch --all`；有参 = `git fetch <remote>` | 复用同一命令名，避免两个抓取入口；不加 `--prune`，行为与既有 fetch 一致 |
| `delete_remote_branch(remote, branch)` | `git push <remote> --delete refs/heads/<branch>` | 错误映射复用 `map_push_err` |
| `set_upstream(branch, upstream)` | `git branch --set-upstream-to=<upstream> <branch>` | 非法 upstream 由 git 拦截并规整 |
| `unset_upstream(branch)` | `git branch --unset-upstream <branch>` | 无上游时 git 报错，前端应已禁用 |
| `create_tag(name, target?, message?)` | 有 message → `git tag -a <name> <target> -m <msg>`，无 → `git tag <name> <target>` | 名称校验：非法字符 / 已存在给表单错误；菜单总是传该提交 id |
| `checkout_commit(hash)` | `git switch --detach <hash>` | 脏树由前端拦截，git 兜底 |
| `amend_message(message)` | `git commit --amend -m <message>` | 仅 HEAD；暂存区非空时必须额外确认（见安全模型） |
| `rebase(ref)` | `git rebase <ref>` | 目标 ref 由菜单传入（本地分支名或 `origin/x`） |
| `continue_operation(op, action)` | `action = "continue" \| "skip"`；rebase 跳过 = `git rebase --skip` | 其它 op 只接受 continue |
| `abort_operation(op)`（扩展） | 增 `Operation::Rebase` → `git rebase --abort` | 既有设施扩展 |
| `get_compare(base, head)` | 两端 `CommitEntry` + `git diff --numstat <base>..<head>` + `git diff <base>..<head>` | 返回 `CompareResult { base, head, files: FileStat[], patch: string \| null }`，与提交详情复用同一套渲染 |

- **`Operation::Rebase` 接入**：`read_operation` 增识别（`git rev-parse --git-path rebase-merge` / `rebase-apply` 目录存在，优先级最高——变基中途 HEAD 处于分离态）；`as_str()` 加 `"rebase"`；前端 `GitOperation` 并集、横幅文案表（`rebase: { progress: "变基进行中", cont: "继续变基" }`）各加一项；冲突视图在 `operation === "rebase"` 时多渲染一个「跳过本次提交」。
- **`git rebase --continue` 的非交互性**：该次调用需注入 `GIT_EDITOR=true`（等价于接受 git 生成的提交信息）。`GitRepo::run` 若无 env 能力，新增一个最小 env 变体，不改既有调用点。
- **剪贴板**：优先 `navigator.clipboard.writeText`；若在 WebView2 下不可用（非安全上下文 / 无权限）回退 `document.execCommand("copy")`。失败时 toast 报错，不静默。
- 所有新增 git 能力都走 `src-tauri/src/git.rs` 封装层（spawn 真实 git），组件一律经 `src/lib/ipc.ts` 类型化包装，不直接 invoke。

### 安全模型（沿用既有拦截，新增三项）

- **检出（本地/远程/修订）与变基**：脏工作树 → 既有三选拦截框（带着改动继续 / stash 后继续 / 取消），变基的选项文案为「stash 后变基」。
- **修改提交信息**：`git commit --amend` 会把已暂存的改动一并并入提交。暂存区非空时，对话框在标题下追加一行警告「暂存区有 N 个已暂存文件，将一并并入本次提交」，并要求用户在对话框里确认后才执行。
- **删除远程分支 / 变基 / 重置**：危险项 + 确认框，文案写清后果（远程分支会被删除且不可从本地恢复 / 本地提交会被重写）。
- **分离 HEAD 下的写操作矩阵**：可用 = 检出、提交、stash、新建标签、复制类、查看；禁用并附「先从此处新建分支」提示 = 推送、抓取（无上游可抓）、合并、变基、重命名、删除分支、设置/取消上游、修改提交信息。

### 分离 HEAD 的状态表达

- 侧栏「分支」区顶部新增状态行 `HEAD（分离）→ <短号>`（`summary.branch === null` 且 HEAD 存在时出现），点击 = 定位该提交；样式沿用既有分支行，配 `GitBranch` 图标与 `text-warn` 强调色。
- 提交菜单「检出该修订」在目标提交即 HEAD 时禁用（避免无意义操作）。

### 「与 HEAD 比较」

- `repo.ts` 加 `compare: { base: string; head: string } | null`（base = HEAD，head = 所选提交）。
- 右栏 `RightPane` 渲染优先级：冲突视图 → stash 查看 → **比较模式** → 提交详情 / 工作区 diff。
- 比较面板：头部显示 `HEAD (<短号>) ↔ <短号> <subject>` + 文件列表（复用 `FileStat` 渲染）+ 统一 patch（复用 `CommitDetailPanel` 的 patch 渲染；若当前是内联实现，抽成 `PatchView` 基元再复用，不复制粘贴）。
- 退出条件沿用既有上下文感知显隐规则：关闭右栏 / 切换中栏 tab / 选中另一提交 → 退出比较模式。
- patch 为空（两端内容相同）时显示「与 HEAD 无差异」。

### 术语改词（决策 4）

- 改词映射：迁出 → **检出**；摘取 → **拣选**；还原 → **反转提交**。
- 波及面：`src/stores/repo.ts` 的 `FLOW_TEXT` 表、对话框标题/按钮文案、toast 文案、拦截框文案；`Sidebar.tsx` / `GraphList.tsx` 的菜单文案（改词后由 `menus.ts` 承载）；`repo.test.ts` 中 8 处断言字符串。
- ui-spec §菜单条目组织一条同步改写为「术语统一用『检出』（checkout）、『拣选』（cherry-pick）、『反转提交』（revert）」。
- 历史 spec（`.scratch/daily-write-path/*`、`.scratch/conflict-resolution/*`）保持原样，不做回写。

### ui-spec 增补清单（规则先行，工单 01）

1. §菜单条目组织：术语改词 + 「三份菜单同构项由 `menus.ts` 单点定义」一句。
2. 新增条目：**侧栏分支/远程分支右键菜单的动作集与禁用矩阵**（含「从此处新建分支 = 该分支 tip」的语义钉子）。
3. 新增条目：**提交右键菜单的动作集、顺序与危险项下沉规则**。
4. 新增条目：**分离 HEAD 的侧栏状态行与写操作禁用矩阵**。
5. 新增条目：**右栏「比较」模式的渲染优先级与退出条件**。

### 工单拆分与顺序（依赖即顺序）

| # | 工单 | 依赖 |
| --- | --- | --- |
| 01 | ui-spec 增补（上节 5 条） | — |
| 02 | `menus.ts` 构建层 + 复制类动作 + 本地分支菜单对齐（含「从此处新建分支」语义修正、术语改词） | 01 |
| 03 | 远程分支右键菜单（`fetch_remote` 带参 + `delete_remote_branch`） | 02 |
| 04 | 上游管理（`list_refs` 带 upstream + set/unset upstream）+ 本地分支菜单的推送/抓取入口 | 02, 03 |
| 05 | 新建标签（`create_tag`） | 02 |
| 06 | 检出该修订 + 分离 HEAD 状态表达与禁用矩阵 | 02 |
| 07 | 变基（`rebase` + `Operation::Rebase` + 继续/跳过/中止） | 01, 02 |
| 08 | 与 HEAD 比较（`get_compare` + 右栏比较模式） | 02 |
| 09 | 修改提交信息（HEAD amend + 暂存区警告） | 02 |
| 10 | （后续，不阻塞本批验收）任意提交 reword | 07 |
**拆分纪律**：工单 02 只建骨架与自身能力可支撑的项；每个后续工单把自己那几项加进 `menus.ts`，菜单里不允许出现
「点了没反应」的占位项（例如变基项由 07 加、标签项由 05 加、检出该修订项由 06 加）。

## Testing Decisions

- **好测试只测外部行为**，沿用两道既有接缝，不新建：
  1. **Rust git 封装层公开函数**（`cargo test`，真实 git + tempfile 夹具仓库）。既有夹具可直接复用：`repo_with_origin()`、`repo_with_two_remotes()`。覆盖：带参 `fetch`、`delete_remote_branch`（含不存在分支的报错形态）、`set/unset_upstream`、`create_tag`（轻量 + 附注，断言 `for-each-ref` 的 peeled tip）、`checkout_commit`（断言 log 的 detached 分支与 `branch_summary` 无 upstream）、`amend_message`（消息改写 + 暂存区非空时的实际行为）、`get_compare`（文件与 patch 形状、无差异场景）、**rebase**：无冲突成功、冲突停下（断言 `operation == rebase` 与未合入清单）、`--continue`、`--abort`、`--skip` 五条路径。
  2. **前端 store 状态流转**（`vitest`，mock IPC）：新流程的成功/失败/拦截条件（脏树 × 检出/变基）、比较模式的进入退出、分离 HEAD 下的禁用判定、复制类动作的 toast。
- **`menus.ts` 作为纯逻辑**新增单测：三份菜单的项集合、禁用/危险标记、分组顺序、动态 ref 组在有无分支两种提交上的差异。先例：`src/lib/refs.test.ts`。
- UI 组件（`ContextMenu` 渲染、右栏比较面板）不做单元测试，遵循仓库既定约束（前端测试只覆盖纯逻辑）。
- 「右键菜单在真实 WebView2 下的观感与剪贴板可用性」属于人工验收项，不写自动化。

## Out of Scope

- 任意提交的「修改提交信息」（reword）——工单 10。
- force push / `--force-with-lease`（变基改写过历史后只给提示，不提供强制推送入口）。
- worktree 管理、remote 管理（add/remove/rename/prune）、标签的删除/重命名/推送（本批只做「新建标签」）。
- 部分暂存类 stash、pull 策略切换、凭据管理。
- 提交图谱的多选与批量操作、侧栏分组标题行的右键菜单。
- 双提交范围比较的「任意两端点」选择 UI（本批固定 base = HEAD，只做「与 HEAD 比较」）。

## Further Notes

- 本 spec 的 Status 自 `needs-triage` 起：请用户 review 本文件后再转 `ready-for-agent`，之后由 `/to-tickets` 拆出 `issues/NN-<slug>.md`。
- 我方相对同类客户端多出的菜单（提交菜单动态 ref 组、stash 菜单、工作区文件菜单、多远程推送分裂按钮、冲突解决入口、变基的「跳过本次提交」出口）一律保留，本批只增不减。
- 变基的失败体验是这批最容易翻车的地方（编辑器拉起、mid-rebase 的 HEAD 分离态、continue 后的信息确认）。实现时先写 rebase 的五条路径测试，再接 UI。
