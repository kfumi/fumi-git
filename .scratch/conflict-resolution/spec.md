Status: ready-for-agent

# Spec：FumiGit 第二阶段 — 冲突解决 + 历史修正（revert / cherry-pick）

> 来源：2026-10-07 第二阶段规划（第一阶段 grilling 会话的后续批次建议顺序）。
> 用户未逐题确认，以下决策由 agent 按推荐方案代持，均标注于「Implementation Decisions」，可随时推翻重写。

## Problem Statement

第一阶段把冲突的「发现与退出」铺好了：仓库能识别合并进行中、能列出冲突文件、能中止合并。但冲突真正的「解决」仍然只能去终端——用户在 FumiGit 里看到「3 个冲突文件」后，接下来的每一步（对比双方、取舍内容、标记已解决、完成合并）都得回命令行。同样，日常的历史修正动作 revert（撤销一个已发布的提交）和 cherry-pick（把别的分支上的一个提交摘过来）也还没有入口。图谱是主角的客户端，看得到提交却改不了历史，价值折半。

## Solution

合并冲突发生时，用户在应用内完成全部解决动作：点开冲突文件看到我方/对方两版内容与当前工作区结果的三方对比；对每个冲突块一键「采用我方 / 采用对方」（也接受在外部编辑器手动改完）；全部处理完点「标记已解决并继续合并」，仓库干净收场。revert 和 cherry-pick 进入提交右键菜单，遇冲突时自动落入同一套冲突解决流程而不是报错弹窗。第二阶段交付后，用户从分叉到解决冲突可以全程不碰终端。

## User Stories

**冲突解决视图**

1. 作为开发者，改动 tab 下的冲突文件组里点开一个冲突文件，我想看到我方版本、对方版本与工作区当前结果的三方信息，以便理解冲突从哪来。
2. 作为开发者，工作区结果中的冲突块我想看到高亮分块（<<<<<<< 标记解析），以便快速定位要处理的块。
3. 作为开发者，每个冲突块我想一键「采用我方 / 采用对方」，应用把剩余块与无冲突内容拼写回文件，以便逐块消灭冲突。
4. 作为开发者，我也可以在外部编辑器里手动编辑冲突文件，然后只点「标记已解决」，以便保留手工合并的自由。
5. 作为开发者，文件级我想一键「整个文件采用我方 / 采用对方版本」，以便冲突太多时直接选边。
6. 作为开发者，所有冲突块都处理后（或文件已无冲突标记），我点「标记已解决」，该文件从冲突组消失并进入已暂存区，以便推进合并。
7. 作为开发者，全部冲突解决后我想点「继续合并」，应用完成合并提交（沿用 git 生成默认提交信息），以便收尾不碰终端。
8. 作为开发者，解决过程中我随时可以「中止合并」（一阶段已有），以便反悔。

**cherry-pick / revert**

9. 作为开发者，提交图谱上右键任意提交我想「择取此提交（cherry-pick）」，把它应用到当前分支，以便摘取别的分支上的修复。
10. 作为开发者，cherry-pick 产生冲突时我想进入与合并相同的冲突解决流程（含中止），以便用同一套心智处理。
11. 作为开发者，空提交（内容已在当前分支）的 cherry-pick 我想看到明确提示并可跳过或继续（--empty 处理），以便不被莫名的失败卡住。
12. 作为开发者，提交图谱上右键我想「还原此提交（revert）」，自动生成 `Revert "<subject>"` 提交并落在当前分支，以便撤销已推送的错误修改而不改写历史。
13. 作为开发者，对合并提交尝试 revert 时我想得到明确解释（需要指定主线，暂不支持），以便知道为什么不能做。
14. 作为开发者，cherry-pick / revert 执行中我想看到进行中反馈并防重复触发（沿用一阶段安全模型），以便操作可控。

**状态与契约**

15. 作为开发者，合并/摘取/还原进行中的状态标识我希望泛化为「进行中的操作」（merge / cherry-pick / revert），以便三类操作共用冲突视图与中止出口。
16. 作为开发者，冲突解决的所有 git 行为（stages 读取、checkout --ours/--theirs、add、merge --continue、cherry-pick --abort）都走既有 git 封装层并有真实夹具测试，以便行为与真 git 一致。

## Implementation Decisions

- **批次边界**：本批 = 冲突解决 UI + revert/cherry-pick。rebase、tag、worktree、force push、remote 管理、detached HEAD、部分暂存 stash 留待后续批次（顺序不变）。
- **冲突深度（代持决策）**：做「三方对比 + 文件级采用 + 冲突块逐块取舍 + 标记已解决 + 继续合并」；**不做内嵌代码编辑器**——细粒度手动编辑走系统编辑器打开文件（tauri opener 已在依赖中），应用负责导航、取舍与状态推进。
- **三方内容来源**：冲突文件的三个版本从 git index stages 读取（`:1:path` = 共同祖先 / `:2:` = 我方 / `:3:` = 对方），不解析 MERGE 消息；视图用现有 diff 渲染能力组合。
- **逐块取舍实现**：前端解析工作区文件中的 `<<<<<<< / ======= / >>>>>>>` 标记为块序列，块按钮选择后由前端拼装新内容**写回工作区文件**；写回不自动 add，「标记已解决」才执行 `git add`。无子块粒度（行级取舍不做）。
- **文件级采用**：采用我方 = `git checkout --ours -- <path>` 后直接 `git add` 标记已解决（选边即解决）；采用对方同理。与逐块取舍互斥使用，以后一次为准。
- **状态契约演进（代持决策，破坏性变更）**：`RepoStatus.merging: bool` 演进为 `operation: "merge" | "cherry-pick" | "revert" | null` + 保留 unmerged 清单；前端横幅按 operation 渲染文案，「中止」路由到对应 abort（merge --abort / cherry-pick --abort / revert --abort）。
- **revert 边界（代持决策）**：仅支持普通提交；合并提交明确报错并解释需要 -m 主线（后续批次再议）。revert 自动提交，沿用 git 默认消息，不弹编辑器。
- **cherry-pick 边界（代持决策）**：单提交粒度；空提交（--empty 情形）提示用户选择跳过或允许；冲突时进入 operation=cherry-pick 的冲突流程。
- **继续合并提交**：冲突全部标记已解决后执行 `git merge --continue`（沿用 MERGE_MSG），不要求用户填写信息。
- **安全模型**：revert/cherry-pick 走 runWrite（writeBusy 守卫 + busy toast）；cherry-pick 前若工作区脏直接拒绝（提示先提交或 stash），与一阶段模型一致。
- **UI 位置**：冲突解决视图挂在改动 tab 下的冲突文件行点击展开（复用右栏机制，类似 stash diff 的整体替换）；revert/cherry-pick 入口为提交图谱右键菜单新两项，菜单骨架沿用。
- **测试接缝**：沿用两道既有接缝——Rust git 封装层真实夹具（构造冲突/摘取场景断言 stages 与状态），store mock IPC 测状态流转与确认弹窗触发；UI 不单测。

## Testing Decisions

- 好测试只测外部行为：Rust 侧真实 git 夹具上构造分叉→merge 冲突，断言 stages 读取、checkout --ours/--theirs 后的 index 状态、标记已解决后的 unmerged 消失、merge --continue 后的提交拓扑；cherry-pick 冲突与空提交同理。不 mock git。
- 前端 store 测试（mock IPC）：operation 状态渲染路由、冲突块拼装逻辑（纯函数单独测）、确认弹窗触发条件。
- UI 组件不做单元测试（仓库约束）。

## Out of Scope

- 内嵌合并编辑器（Monaco / CodeMirror 级）、行级手动取舍。
- rebase（含交互式）、tag 管理、worktree、force push、remote 管理、detached HEAD、部分暂存 stash、pull --rebase。
- revert 合并提交（-m 主线选择）。
- 冲突的 rerere / 合并工具（如 Beyond Compare）对接。

## Further Notes

- 后续批次顺序不变：rebase → tag → worktree → force push / remote 管理。
- `RepoStatus` 契约破坏性变更需同步三层（Rust serde / types.ts / store 消费点），一阶段的合并横幅与中止按钮按 operation 改写。
- 本批落地后，冲突解决视图的拼装函数（标记解析 + 块取舍）应为纯函数以便 vitest 直测。
