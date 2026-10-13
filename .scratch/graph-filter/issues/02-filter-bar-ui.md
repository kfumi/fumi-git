# 02 — 前端：筛选栏（分支 / 提交者 / 日期三块下拉）

**What to build:** store 增 `logFilter`（`LogFilter`）、`identity`（`UserIdentity | null`）、`authorStats`（按已加载提交统计的「最近提交者」），
动作 `setLogFilter(patch)` / `resetLogFilters()` / `reloadLog()`；`loadMore` 与 `refresh` 一律带当前 `logFilter`。
`loadMore`/`refresh`/`reloadLog` 共用同一个「日志页落地」纯函数（保留仍存在的选中项、消失即收起详情与文件 tab、未按提交者筛选时刷新作者统计）。
新增纯函数模块 `src/lib/filterMenu.ts`：三块下拉的条目（勾选态 / 禁用规则 / 提交数 hint / 分组标题）与按钮文案单点定义，
组件不得自带文案与禁用条件（同 ui-spec §4 对右键菜单的要求）；`AuthorStat` / `authorStatsOf` / `authorPattern` / `logFilterActive` 一并落在这个模块。
新组件 `src/components/FilterBar.tsx` 挂在 `MainArea` 的 tab 行下方（仅历史 tab 显示）：
分支（`分支：所有分支` / `分支：<name>`，列表头「分支」+ 勾选的「所有分支」+ 本地分支列表）、
提交者（头「提交者」+ 勾选「全部」+「只看我的」+ 分组标题「最近提交者」+ 带计数的提交者行 + 底部输入框「输入姓名或邮箱，回车过滤…」）、
日期（头「日期」+ 全部时间 / 最近 24 小时 / 最近一周 / 最近一月），外加筛选生效时的「清除筛选」按钮。
下拉复用 `ContextMenu`，为其补 `checked` / `kind:"header"` / `footer` / `maxListH` / `anchor`，并修掉「容器内滚动会关菜单」。
`GraphList` 空态区分「当前筛选下没有提交」（附清除筛选入口）与「这个仓库还没有提交」。

**Blocked by:** 01

**Status:** ready-for-agent

- [x] 三块下拉的条目、勾选态、分组标题、计数与输入框照参考截图（`lib/filterMenu.test.ts` 断言条目序列、`checked`、`hint`、`title`、分组标题与分隔线）
- [x] 选择任一条目后菜单关闭、图谱按新筛选重取第一页（保留已加载深度：已加载 300 条 → `getLog(0, 300, filter)`）
- [x] 选中项被筛掉时选中态、详情与已打开的文件 tab 一并收起
- [x] 「只看我的」用 `user.email`（退化到 `user.name`）过滤；未配置时该项禁用并 hint「未配置 user.email」
- [x] 手输姓名/邮箱回车即过滤并收起下拉；重新打开菜单时回显当前自定义值
- [x] 有筛选生效时出现「清除筛选」按钮，无筛选时不占位（`resetLogFilters` 回到默认并重取）
- [x] 「最近提交者」统计在提交者筛选生效时保持上一份快照（仍能切到别人），未筛选时随翻页增长
- [x] `loadMore` / `refresh`（含文件监视触发的 refresh）都带当前筛选，不被静默重置；`refresh` 同时落下 git 身份
- [x] 空态文案区分「当前筛选下没有提交」与「这个仓库还没有提交」，并提供清除筛选入口
- [x] `pnpm test` 与 `pnpm build`（含 tsc）通过

**Comments**

- 2026-10-13 完成。store：`logFilter` / `identity` / `authorStats` + `setLogFilter` / `resetLogFilters` / `reloadLog`，`logPagePatch()` 统一落地（选中项保留 + 统计冻结），`loadMore` / `refresh` 带筛选并拉取身份。
- 条目与文案抽到 `src/lib/filterMenu.ts`（`filterMenuItems` / `filterButtonLabels` / `authorStatsOf` / `authorPattern` / `logFilterActive` / `SINCE_ITEMS`），组件只保留渲染与落位——与 `lib/menus.ts` 同构。
- `ContextMenu` 补 `checked` / `kind:"header"` / `footer` / `maxListH` / `anchor` / `title`，并把「容器内滚动即关闭」修正为「面板外滚动才关闭」；`checked` 位只在列表里出现过勾选项时才占位，三份右键菜单排版不变。
- 新组件 `FilterBar`（三块下拉 + 清除筛选）挂 `MainArea` 历史 tab 内；`GraphList` 空态区分筛选为空与仓库为空。
- 验证：`pnpm test` **158 passed / 7 files**（新增 `lib/filterMenu.test.ts` 11 条、`repo.test.ts` 新增 6 条 store 流转、`components/filterbar.smoke.test.tsx` 3 条渲染冒烟），`pnpm build` tsc + vite 通过，exit 0。
- 记录一个测试环境的坑：`renderToStaticMarkup` 走的是 `useSyncExternalStore` 的 **server 快照**（zustand 传的是初始状态），所以 SSR 下筛选栏只会渲染默认态——「随当前筛选变化的内容」必须靠 `lib/filterMenu.ts` 的纯函数断言覆盖，冒烟测试只断言默认态与菜单基元结构。

## 评审整改（2026-10-13）

- **并发串味（真实缺陷，已修）**：新增单调 `logToken`。`reloadLog` / `refresh` 递增代次、落地前校验（连点筛选时后到的慢响应直接作废）；`loadMore` 只记录代次 + 仓库身份 + 列表长度，任一变化即丢弃这一页，不再把旧视角的提交灌进新列表。`openRepo` / `closeRepo` 补 `loadingMore: false`。
- **日志失败拖死整个刷新（真实缺陷，已修）**：抽出 `fetchLogFirstPage()`，日志失败不再中断 `status/summary/refs/identity` 的落地；失败且筛在某个分支上时自动退回「所有分支」重试一次并提示（分支被删除的自愈路径，否则图谱与侧栏会双双卡住）。
- **身份瞬时失败把入口变灰（已修）**：`identity ?? get().identity` 保留上一份。
- **「最近提交者」行没有勾选反馈（已修）**：生效中的提交者行打勾（`f.author === s.email || s.name`），但生效值等于「只看我的」时不重复勾同名统计行。
- 新增测试：连点筛选（慢响应作废）、换筛选期间旧分页被丢弃、分支已不存在的自愈、`refresh` 日志失败但其余数据面照常落地，以及两条勾选态断言。
- 验证：`pnpm test` → **164 passed / 7 files**，exit 0；`pnpm build`（tsc + vite）exit 0。
- 已知缺口：`ContextMenu` 的 mousedown / scroll 关闭条件没有自动化覆盖（本仓库无 jsdom / @testing-library），只能人工验证；要补需先引入 DOM 测试栈。
