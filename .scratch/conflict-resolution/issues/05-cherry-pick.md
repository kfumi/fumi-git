# 05 — cherry-pick：择取单提交

**What to build:** 提交图谱右键新项「择取此提交（cherry-pick）」：确认后把该提交应用到当前分支并自动提交；空提交（内容已在当前分支）给出「跳过 / 继续（--empty=keep? 按 git 行为）」的明确选择；遇冲突进入 operation=cherry-pick 的冲突解决流程（02 的视图与中止出口）。

**Blocked by:** 01（operation 契约）, 02（冲突解决视图）

**Status:** ready-for-agent

- [ ] 右键提交 → 确认 → cherry-pick 成功后当前分支多出同改动提交，图谱刷新
- [ ] 空提交场景给出可读选择，不再以裸报错卡死
- [ ] cherry-pick 遇冲突：operation=cherry-pick 的横幅、冲突清单、解决与中止出口全部可用
- [ ] 脏工作树时被拒绝并提示先提交或 stash
- [ ] 单提交粒度（不做序列 pick）；Rust 夹具测试覆盖成功/空/冲突三场景；store 测试覆盖确认与冲突流转
