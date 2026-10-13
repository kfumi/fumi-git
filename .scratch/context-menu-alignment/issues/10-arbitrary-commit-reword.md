# 10 — 任意提交的「修改提交信息」（reword，后续批次）

**What to build:** 把「修改提交信息…」从 HEAD 扩展到任意历史提交。难点与非 HEAD amend 的实现路径：需要自己驱动 `git rebase -i` 的 todo（`GIT_SEQUENCE_EDITOR` 之类的手段，跨平台且不得依赖用户已装 bash），冲突走既有冲突解决流程（`Operation::Rebase`，见工单 07），并在改写后刷新整段下游提交的哈希与图谱。本票**不阻塞**第三阶段其它工单的验收，排在其后。

**Blocked by:** 07（`Operation::Rebase` 与 rebase 冲突流程）

**Status:** needs-triage

- [ ] 明确跨平台的 rebase todo 驱动方案（不依赖交互式编辑器、不假设存在 bash），并把方案记进本票或 spec
- [ ] 非 HEAD 提交的「修改提交信息…」入口启用，改写后下游提交哈希与图谱一致刷新
- [ ] 改写过程中产生冲突时落入既有 rebase 冲突流程，可继续/跳过/中止
- [ ] 改写失败时工作区与分支指针回到操作前状态（无半途卡死的 rebase 残留）
- [ ] Rust 夹具测试覆盖中间提交 reword 成功、冲突、以及改写后下游提交哈希变化
