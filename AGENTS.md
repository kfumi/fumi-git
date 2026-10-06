# FumiGit — Agent 指南

## Agent skills

### Issue tracker

本地 markdown：spec 与工单以文件形式存于 `.scratch/<feature-slug>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五角色词汇（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`），在本地跟踪器中体现为文件顶部 `Status:` 行。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.

## 项目速览

- 面向开发者的开源 Git 可视化客户端；**提交图谱是主角**，其它功能围绕它组织。
- Tauri 2（Rust 后端 + React 19 前端）；**git CLI 是唯一 Git 后端**（spawn + porcelain 解析，禁止引入 libgit2/gitoxide 作为行为源）。
- 首发平台 Windows；代码保持平台中立（不写死路径分隔符与平台专属 API）。
- 设计令牌与布局定稿：`docs/design/ui-spec.md`（变体 A 三栏工作台，2026-10 定稿）。
- 命名：目录/仓库 `fumi-git`，应用名 `FumiGit`，Rust 包 `fumi-git`（lib 名 `fumi_git_lib`），identifier `com.fumigit.app`。

## 常用命令

```bash
pnpm install        # 用 pnpm，勿用 npm/yarn
pnpm tauri dev      # 桌面开发运行
pnpm build          # 前端构建，含 tsc 类型检查（无独立 typecheck 脚本，也无 ESLint/Prettier）
pnpm test           # 前端单测（vitest run）：graph / lib / stores 纯函数
cargo test          # 在 src-tauri/ 下：真实 git + tempfile 构造夹具仓库，不 mock git
```

- 性能验收夹具大仓库：`scripts/gen-perf-repo.sh <目标目录> [提交数]`（git fast-import 生成）。
- 应用图标改后需重新生成全套尺寸：`pnpm tauri icon docs/design/brand/app-icon.png`。

## 架构边界

- **Git 唯一入口：`src-tauri/src/git.rs`**。所有 Git 读写都 spawn 真实 git 进程、解析 porcelain 输出（由此继承用户 gitconfig/hooks/credential helper）；禁止引入 libgit2/gitoxide 作为行为源。
- **前端 IPC 唯一出口：`src/lib/ipc.ts`**。组件禁止直接 `invoke` 裸字符串命令。新增 Tauri 命令三处同步：`commands.rs` 定义 → `src-tauri/src/lib.rs` 的 `invoke_handler` 注册 → `ipc.ts` 加类型化包装。
- **IPC 类型契约：`src/lib/types.ts`**（与 Rust serde 结构对应；`GitError` 是 `kind/message` tagged enum，前端经 `asGitError` 规整）。`src/stores/repo.ts`（zustand）是前端唯一业务状态源。
- **图谱 lane 分配：`src/graph/lane.ts`** 纯函数；lane 回收/配色规则以 `docs/design/ui-spec.md` 为准，改行为先改规则再改代码。

## UI / 设计

- 动任何 UI 前先读 `docs/design/ui-spec.md`（三栏工作台布局、主题令牌、图谱配色已定稿，勿自行发明样式值）；主题一律走 CSS 变量（`html[data-mode]`）。
- 右栏（工作文件 diff / 提交详情）默认不渲染、上下文感知显隐；侧栏宽度像素级持久化。细节见 ui-spec 的逐条增补说明。

## 已知坑

- 首发平台 Windows，但代码保持平台中立：不写死路径分隔符、不用平台专属 API。
- Vite 固定端口 1420（strictPort，被占用直接失败）；`src-tauri/**` 已从 Vite watch 排除。
- 前端测试只覆盖纯逻辑（lane/refs/store）；涉及真实 git 行为的验证在 Rust 侧 `cargo test`。
