# 09 — 修改提交信息（HEAD amend）

**What to build:** 提交右键菜单新增「修改提交信息…」，本批**只支持 HEAD 提交**：非 HEAD 提交该项禁用并给 hint「仅 HEAD」（任意提交的 reword 见工单 10）。后端新增 `amend_message(message)`（`git commit --amend -m <message>`）。前端对话框预填 HEAD 当前的完整提交信息（subject + body，按需经 `get_commit_detail` 拉取），确认后改写提交信息并刷新图谱与详情。**安全模型**：`git commit --amend` 会把已暂存的改动一起并入提交，因此暂存区非空时对话框必须追加一行明确警告「暂存区有 N 个已暂存文件，将一并并入本次提交」，用户在知情后确认才执行；空信息被表单拦截。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [ ] 右键 HEAD 提交 →「修改提交信息…」→ 对话框预填当前信息 → 确认后图谱该行 subject 更新，提交哈希改变
- [ ] 非 HEAD 提交该菜单项禁用并给 hint「仅 HEAD」
- [ ] 暂存区非空时对话框显示「暂存区有 N 个已暂存文件，将一并并入本次提交」的警告，且确认后暂存改动确实并入（以 `git show --stat` 验证）
- [ ] 信息为空被表单拦截，不发 git 请求
- [ ] 改写后右栏详情与侧栏 ahead/behind 徽章刷新（已推送分支会体现 behind/ahead 变化）
- [ ] Rust 夹具测试覆盖 amend 改写信息、暂存区非空时的合并行为
- [ ] store 测试覆盖成功路径与暂存区警告的出现条件
- [ ] `cargo test` 与 `pnpm test` 通过
