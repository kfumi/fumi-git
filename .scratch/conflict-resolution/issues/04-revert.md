# 04 — revert：还原普通提交

**What to build:** 提交图谱右键新项「还原此提交（revert）」：确认后对普通提交执行 `git revert --no-edit`，自动生成 `Revert "<subject>"` 提交落在当前分支；合并提交被拦截并解释（需指定主线，暂不支持）；遇冲突时进入 operation=revert 的冲突解决流程（02 的视图与中止出口）。

**Blocked by:** 01（operation 契约）, 02（冲突解决视图）

**Status:** ready-for-agent

- [ ] 右键普通提交 → 确认框 → revert 自动提交，图谱出现 `Revert "…"` 提交
- [ ] 合并提交的 revert 被结构化报错拦截，文案解释需 -m 主线
- [ ] revert 遇冲突：operation=revert 的横幅、冲突清单、解决与中止出口全部可用
- [ ] 脏工作树时 revert 被拒绝并提示先提交或 stash（沿用一阶段安全模型）
- [ ] Rust 夹具测试覆盖 revert 提交、合并提交拦截、冲突场景；store 测试覆盖确认与冲突流转
