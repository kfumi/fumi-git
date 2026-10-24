# 09 — 修改提交信息（HEAD amend）

**What to build:** 提交右键菜单新增「修改提交信息…」，本批**只支持 HEAD 提交**：非 HEAD 提交该项禁用并给 hint「仅 HEAD」（任意提交的 reword 见工单 10）。后端新增 `amend_message(message)`（`git commit --amend -m <message>`）。前端对话框预填 HEAD 当前的完整提交信息（subject + body，按需经 `get_commit_detail` 拉取），确认后改写提交信息并刷新图谱与详情。**安全模型**：`git commit --amend` 会把已暂存的改动一起并入提交，因此暂存区非空时对话框必须追加一行明确警告「暂存区有 N 个已暂存文件，将一并并入本次提交」，用户在知情后确认才执行；空信息被表单拦截。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [x] 右键 HEAD 提交 →「修改提交信息…」→ 对话框预填当前信息 → 确认后图谱该行 subject 更新，提交哈希改变
- [x] 非 HEAD 提交该菜单项禁用并给 hint「仅 HEAD」
- [x] 暂存区非空时对话框显示「暂存区有 N 个已暂存文件，将一并并入本次提交」的警告，且确认后暂存改动确实并入（以 `git show --stat` 验证）
- [x] 信息为空被表单拦截，不发 git 请求
- [x] 改写后右栏详情与侧栏 ahead/behind 徽章刷新（已推送分支会体现 behind/ahead 变化）
- [x] Rust 夹具测试覆盖 amend 改写信息、暂存区非空时的合并行为
- [x] store 测试覆盖成功路径与暂存区警告的出现条件
- [x] `cargo test` 与 `pnpm test` 通过

## Comments

- 2026-10-11 完成（前端提交 995e553）。后端 `amend_message`（`git commit --amend -m <message>`，不经编辑器，多行信息原样传入）；菜单项仅 HEAD 可用（非 HEAD 禁用 + hint「仅 HEAD」），store 侧对「不在已加载提交里」的 id 也一律拒绝（不靠菜单的单点把关）；对话框预填完整信息（`get_commit_detail` 的 body 优先、退回 subject），`multiline` 走 DialogHost 新增的 textarea（Enter 只换行、不触发主动作），暂存区非空时正文追加「暂存区有 N 个已暂存文件，将一并并入本次提交」。
- 验证：Rust `amend_message_rewrites_head_and_folds_staged`（`git show --stat` 断言暂存改动并入）；store 侧非 HEAD 与未加载行拒绝、HEAD 预填（initial = body、multiline）、空信息被 `validate` 拦截、暂存警告文案、改写调用 `amendMessage`；`cargo test -- --test-threads=1` 52 passed / 1 ignored，`pnpm test` 134 passed。
- 评审整改（Critical）：预填此前只取 `detail.body`，而 `CommitDetail.body` 来自 `git show -s --format=%b`——**不含 subject**，因此对「有 subject + body」的 HEAD 提交，保存后原 subject 会被正文首行顶掉（信息静默丢失）。现按 `subject + "\n\n" + body` 拼全量信息，测试里固化的旧断言（`initial === body`）已改成真值语义并覆盖「只有 subject」「subject+body」两种。另修：`ipc.amendMessage` 返回类型改 `void`（Rust 侧是 `Result<(),_>`），并改正「--amend --only」的错误注释（无 `--only`，暂存改动确实会并入）。
