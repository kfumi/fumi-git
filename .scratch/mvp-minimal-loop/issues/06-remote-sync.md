# 06 — 远程同步：fetch / pull / push

**What to build:** 工具栏提供拉取（pull）、推送（push）、抓取（fetch）三个动作，均带进行中/成功/失败三态反馈（按钮转圈、结果 toast、错误详情可展开）。侧栏与图谱行显示分支领先/落后远程的 ↑↓ 计数。pull 强制 `--ff-only`：历史分叉时显示明确失败说明与"需要手动处理"指引，绝不静默合并；push 非快进被拒时显示错误与"先拉取"建议。认证完全依赖 git 自身凭证体系（credential helper / SSH agent），凭证失败透传为友好错误。

Rust 侧新增 `fetch`/`pull`/`push`（异步执行、进度上报）与 `get_branch_summary`（rev-list 计数领先/落后、上游存在性）。测试夹具：本地 bare 仓库充当 origin，覆盖同步、落后、领先、分叉四态。

**Blocked by:** 03（图谱与 ref 徽章，同步结果要在行内可见）。

**Status:** ready-for-agent

- [x] fetch/pull/push 全程有进行中指示，结束后有成功/失败反馈
- [x] ↑↓ 计数与真实仓库状态一致，同步后自动刷新
- [x] 分叉时 pull 失败并显示指引，仓库状态未被改变（--ff-only）
- [x] 非快进 push 被拒时显示可读错误与下一步建议
- [x] 无上游分支时 push 提示而非报错崩溃
- [ ] 凭证失败（本地夹具模拟无凭证场景）透传为友好错误
- [x] 封装层测试覆盖 bare-origin 四态夹具（同步/落后/领先/分叉）

## Comments

实现：fetch --prune / pull --ff-only（NonFastForward 结构化错误）/ push（无上游给 NoUpstream 指引）、get_branch_summary（rev-list --left-right --count）。测试 fetch_pull_fast_forward_and_divergence / push_no_upstream_is_structured_error / push_ahead_succeeds 全绿。凭证复用 git 凭证体系（CLI 继承）。
