# 01 — 状态契约演进（operation）+ 冲突三方内容读取

**What to build:** 仓库状态把 `merging: bool` 升级为 `operation: "merge" | "cherry-pick" | "revert" | null`（检测 MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD），冲突文件清单不变；同时封装层提供冲突文件三方内容的读取（index stages：`:1:` 共同祖先 / `:2:` 我方 / `:3:` 对方）。前端一阶段的合并横幅与「中止合并」按 operation 渲染文案并路由对应 abort。本票是冲突视图与历史修正的共用底座。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 真实 merge / cherry-pick / revert 冲突夹具下，get_status 的 operation 字段分别正确
- [ ] 无进行中操作时 operation 为 null，前端横幅不渲染
- [ ] stages 读取返回 base/ours/theirs 三个内容（文件不存在于某 stage 时为空）
- [ ] 「中止」按钮按 operation 执行对应 abort 命令，仓库恢复操作前状态
- [ ] 前端 types.ts / store 消费点同步契约变更，一阶段行为（合并横幅、中止）不回退
- [ ] Rust 夹具测试覆盖三种 operation 的识别与 abort 路由；store 测试覆盖横幅文案路由
