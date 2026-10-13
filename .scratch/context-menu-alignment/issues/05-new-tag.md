# 05 — 新建标签（提交菜单）

**What to build:** 提交右键菜单新增「新建标签…」：对话框输入标签名 + 可选备注。后端新增 `create_tag(name, target?, message?)`——有 message 走 `git tag -a <name> <target> -m <msg>`（附注标签），无 message 走 `git tag <name> <target>`（轻量标签）；菜单调用时 `target` 恒为该提交 id。前端在表单阶段做名称校验：非法字符（git 的 ref 命名规则）与已存在同名标签都即时反馈，不让用户等到 git 报错；标签已存在时提示可在侧栏标签区看到它。成功后刷新 refs，侧栏标签区按既有规则（创建时间倒序）出现该标签，图谱上该提交的 ref 装饰同步出现。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [x] 右键提交 →「新建标签…」→ 填名称（可留空备注）→ 侧栏标签区与图谱 ref 装饰出现该标签
- [x] 有备注时生成附注标签（`for-each-ref` 的 peeled tip 剥到所标注提交，与既有 `list_refs_peels_annotated_tag_to_commit` 行为一致）；无备注时为轻量标签
- [x] 标签名非法字符（空格、`~^:?*[\`、`..`、以 `/` 开头或结尾等）在表单即时反馈
- [x] 重名标签在表单即时反馈，不产生 git 报错弹窗
- [x] Rust 夹具测试覆盖轻量标签、附注标签与 peeled tip；已存在同名标签的报错形态有断言
- [x] store 测试覆盖成功路径与表单校验失败路径
- [x] `cargo test` 与 `pnpm test` 通过

## Comments

- 2026-10-11 完成（前端提交 995e553）。提交菜单「新建标签…」+ 两步对话框（勾选「附加备注」才进第二框，第一框 `run` 返回 `false` 以免宿主关掉刚打开的备注框）；表单即时校验覆盖空名、非法字符、`..`、`@{`、`//`、以 `/` 或 `.` 结尾、以 `.`/`-` 开头、`.lock` 结尾与重名。
- 验证：Rust `create_tag` 相关用例（轻量 / 附注 / peeled tip / 重名与非法参数报错）；store 侧轻量标签一次到位、两步附注标签、`validate` 各分支；`cargo test -- --test-threads=1` 52 passed / 1 ignored，`pnpm test` 134 passed。
