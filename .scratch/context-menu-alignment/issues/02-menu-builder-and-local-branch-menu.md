# 02 — 菜单构建层 + 复制类动作 + 本地分支菜单对齐

**What to build:** 新增纯函数模块 `src/lib/menus.ts`（无 React、不直接调 store），导出 `branchMenu / remoteMenu / commitMenu`，三份菜单的同构项（检出 / 从此处新建分支 / 合并到当前分支 / 复制）由共享内部构造函数产出，禁用规则与文案只有一处定义；组件（`Sidebar.tsx` / `GraphList.tsx`）退化为「铺 `MenuActions` + 记 `{x, y, target}` + 渲染 `ContextMenu`」。本票落地的**本地分支菜单**为：检出（当前分支禁用 + hint 当前分支）、从此处新建分支…、合并到当前分支…（当前分支禁用）、重命名…、删除…（danger，当前分支禁用）、复制分支名 —— 推送 / 抓取 / 设置上游 / 取消上游 / 变基 分别由 04 / 03 / 07 追加，本票不得放占位项。**同时全量落地术语改词**：迁出 → 检出、摘取 → 拣选、还原 → 反转提交（含 `repo.ts` 的 `FLOW_TEXT`、对话框标题与按钮、toast、拦截框文案，以及 `repo.test.ts` 中的断言字符串）。复制类动作走新增的 `copyText`：优先 `navigator.clipboard.writeText`，失败回退 `document.execCommand("copy")`，成功后 toast「已复制分支名」，失败给错误 toast（不静默）。另修正现有缺陷：本地分支菜单的「新建分支…」原本基于 HEAD，改名为「从此处新建分支…」并以**该分支 tip** 为起点。

**Blocked by:** 01（ui-spec 规则先行）

**Status:** ready-for-agent

- [ ] `src/lib/menus.ts` 三个导出函数齐备；组件内不再出现菜单文案与禁用规则字面量
- [ ] 本地分支菜单项与组顺序与 spec 一致；破坏性项 `danger` 且沉底；`…` 只出现在后面有对话框的项上
- [ ] 「从此处新建分支…」以该分支 tip 为起点（单测断言传给 `createBranchFlow` 的 ref 是该分支，不是 HEAD）
- [ ] 「检出」在右键当前分支时禁用并给 hint，不再出现「可以检出到自己」的入口
- [ ] 复制分支名成功后有 toast；剪贴板不可用时走 `execCommand` 兜底或给出错误 toast，两种情况都不静默
- [ ] 术语改词在 UI 文案与测试断言中同步完成，仓库内不再残留「迁出 / 摘取 / 还原」的用户可见串（历史 spec 除外）
- [ ] `menus.ts` 单测覆盖：项集合、禁用/危险标记、分组顺序、动态 ref 组在「提交挂本地分支 / 不挂」两种输入下的差异
- [ ] `pnpm test` 与 `pnpm build`（含 tsc 类型检查）通过
