// 顶部动作栏：仓库切换下拉、分支下拉（左键切换 / 右键操作，↑↓ 计数）、远程动作、搜索、刷新、主题
import { useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  Download,
  GitBranch,
  LoaderCircle,
  Monitor,
  Moon,
  RotateCw,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  localBranchMenu,
  remoteBranchMenu,
  remoteCheckout,
  type BranchMenuActions,
} from "./branchMenu";
import { useRepo } from "../stores/repo";
import { useTheme } from "../theme";
import { useAppearance } from "../appearance";
import type { ThemeMode } from "../lib/types";

const MODES: ThemeMode[] = ["dark", "light", "system"];

const THEME_ICON: Record<ThemeMode, typeof Moon> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

export function Toolbar() {
  const meta = useRepo((s) => s.meta);
  const config = useRepo((s) => s.config);
  const summary = useRepo((s) => s.summary);
  const openRepo = useRepo((s) => s.openRepo);
  const pickAndOpenRepo = useRepo((s) => s.pickAndOpenRepo);
  const closeRepo = useRepo((s) => s.closeRepo);
  const filter = useRepo((s) => s.filter);
  const setFilter = useRepo((s) => s.setFilter);
  const remote = useRepo((s) => s.remote);
  const remotes = useRepo((s) => s.remotes);
  const refs = useRepo((s) => s.refs);
  const checkout = useRepo((s) => s.checkout);
  const createBranchFlow = useRepo((s) => s.createBranchFlow);
  const deleteBranchFlow = useRepo((s) => s.deleteBranchFlow);
  const renameBranchFlow = useRepo((s) => s.renameBranchFlow);
  const mergeBranchFlow = useRepo((s) => s.mergeBranchFlow);
  const pushToFlow = useRepo((s) => s.pushToFlow);
  const pushAllRemotesFlow = useRepo((s) => s.pushAllRemotesFlow);
  const refresh = useRepo((s) => s.refresh);
  const openSettings = useAppearance((s) => s.openSettings);
  const { mode, setMode } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 推送下拉：{ 锚点 }，菜单挂在 caret 按钮下方
  const [pushMenu, setPushMenu] = useState<{ x: number; y: number } | null>(null);
  // 仓库切换下拉：同样挂在仓库名按钮下方
  const [repoMenu, setRepoMenu] = useState<{ x: number; y: number } | null>(null);
  // 分支下拉面板：挂在分支 chip 下方
  const [branchPanel, setBranchPanel] = useState<{ x: number; y: number } | null>(null);
  // 分支行右键操作菜单：{ 位置, 分支全名, 是否远程, tip }
  const [rowMenu, setRowMenu] = useState<
    { x: number; y: number; branch: string; tip: string; remote: boolean } | null
  >(null);

  if (!meta) return null;

  const run = async (op: "fetch" | "pull" | "push") => {
    setBusy(op);
    await remote(op);
    setBusy(null);
  };

  // 仓库切换菜单：最近仓库（当前项不列）→ 打开新目录 → 关闭回欢迎页
  const repoMenuItems = (): MenuItem[] => {
    const items: MenuItem[] = [];
    for (const e of config?.recent_repos ?? []) {
      if (e.path === meta.path) continue;
      items.push({ label: e.name, hint: e.path, onSelect: () => void openRepo(e.path) });
    }
    if (items.length > 0) items.push({ kind: "separator" });
    items.push({ label: "打开仓库目录…", onSelect: () => void pickAndOpenRepo() });
    items.push({ kind: "separator" });
    items.push({ label: "关闭仓库", hint: "回到欢迎页", onSelect: closeRepo });
    return items;
  };

  // 推送去向菜单：当前上游置顶 + 其余远程 + 全部远程
  const pushMenuItems = (): MenuItem[] => {
    const upstreamRemote = summary?.upstream?.split("/")[0];
    const items: MenuItem[] = [];
    if (upstreamRemote) {
      items.push({
        label: `推送到 ${upstreamRemote}`,
        hint: "当前上游",
        onSelect: () => void run("push"),
      });
    } else {
      items.push({ label: "建立上游关联并推送…", onSelect: () => void pushToFlow() });
    }
    const others = remotes.filter((r) => r !== upstreamRemote);
    if (others.length > 0) {
      if (items.length > 0) items.push({ kind: "separator" });
      for (const r of others) {
        items.push({ label: `推送到 ${r}`, onSelect: () => void pushToFlow(r) });
      }
    }
    if (remotes.length > 1) {
      if (items.length > 0) items.push({ kind: "separator" });
      items.push({
        label: `推送到全部远程（${remotes.join("、")}）`,
        onSelect: () => void pushAllRemotesFlow(),
      });
    }
    return items;
  };

  // 分支操作动作集（菜单构建函数与侧栏右键共用，见 components/branchMenu.ts）
  const branchActions: BranchMenuActions = {
    checkout: (b) => void checkout(b),
    createBranchFlow,
    mergeBranchFlow: (b) => void mergeBranchFlow(b),
    renameBranchFlow,
    deleteBranchFlow: (b) => void deleteBranchFlow(b),
  };

  // 分支下拉面板：本地 / 远程两组，左键行 = 切换，右键行 = 该分支操作菜单
  const branchPanelItems = (): MenuItem[] => {
    const locals = refs
      .filter((e) => e.kind === "branch")
      .sort((a, b) => a.name.localeCompare(b.name));
    const remoteRefs = refs
      .filter((e) => e.kind === "remote")
      .sort((a, b) => a.name.localeCompare(b.name));
    const localNames = new Set(locals.map((e) => e.name));
    const ab =
      summary && summary.ahead + summary.behind > 0
        ? ` ↑${summary.ahead} ↓${summary.behind}`
        : "";
    const items: MenuItem[] = [{ kind: "header", label: "本地分支" }];
    if (locals.length === 0) items.push({ label: "暂无本地分支", disabled: true });
    for (const e of locals) {
      const current = summary?.branch === e.name;
      items.push({
        label: e.name,
        active: current,
        disabled: current,
        hint: current ? `当前分支${ab}` : undefined,
        title: `${e.name} → ${e.tip.slice(0, 7)}`,
        onSelect: () => void checkout(e.name),
        onContextMenu: (x, y) => setRowMenu({ x, y, branch: e.name, tip: e.tip, remote: false }),
      });
    }
    if (remoteRefs.length > 0) {
      items.push({ kind: "separator" }, { kind: "header", label: "远程分支" });
      for (const e of remoteRefs) {
        items.push({
          label: e.name,
          title: `${e.name} → ${e.tip.slice(0, 7)}`,
          onSelect: () => remoteCheckout(e.name, e.tip, localNames, branchActions).run(),
          onContextMenu: (x, y) => setRowMenu({ x, y, branch: e.name, tip: e.tip, remote: true }),
        });
      }
    }
    items.push({ kind: "separator" });
    items.push({ label: "新建分支…", hint: "基于当前 HEAD", onSelect: () => createBranchFlow() });
    return items;
  };

  const rowMenuItems = (): MenuItem[] => {
    if (!rowMenu) return [];
    if (rowMenu.remote) {
      const localNames = new Set(refs.filter((e) => e.kind === "branch").map((e) => e.name));
      return remoteBranchMenu(rowMenu.branch, rowMenu.tip, localNames, branchActions);
    }
    return localBranchMenu(rowMenu.branch, summary?.branch === rowMenu.branch, branchActions);
  };

  const doRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const ThemeIcon = THEME_ICON[mode];
  // 推送目标 = 上游远程（无上游时留空，由点击后的弹框引导）
  const pushTarget = summary?.upstream?.split("/")[0] ?? "";

  return (
    <div className="flex h-[42px] shrink-0 items-center gap-1.5 border-b border-brd bg-panel px-3">
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setRepoMenu({ x: r.left, y: r.bottom + 4 });
        }}
        title={meta.path}
        aria-label="切换仓库"
        className="flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-[0.8125rem] font-semibold transition-colors hover:bg-hover"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-ok" aria-hidden />
        {meta.name}
        <ChevronDown size={11} className="shrink-0 text-faint" aria-hidden />
      </button>
      {repoMenu && (
        <ContextMenu
          x={repoMenu.x}
          y={repoMenu.y}
          items={repoMenuItems()}
          onClose={() => setRepoMenu(null)}
        />
      )}
      {/* 分支 chip：点击展开下拉面板（本地/远程分支切换 + 操作），↑↓ 为与上游的差数 */}
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setBranchPanel({ x: r.left, y: r.bottom + 4 });
        }}
        title="切换分支"
        aria-label="切换分支"
        aria-haspopup="menu"
        className="flex h-7 items-center gap-1.5 rounded-lg border border-brd bg-panel2 px-2.5 text-xs font-medium transition-colors hover:border-accent"
      >
        <GitBranch size={11} className="shrink-0 text-accent-ink" aria-hidden />
        {summary?.branch ?? meta.branch}
        {summary?.upstream && (summary.ahead > 0 || summary.behind > 0) && (
          <span className="tnum flex items-center gap-1 text-[0.65625rem] font-normal">
            {summary.ahead > 0 && (
              <span className="flex items-center text-ok">
                <ArrowUp size={9} aria-hidden /> {summary.ahead}
              </span>
            )}
            {summary.behind > 0 && (
              <span className="flex items-center text-warn">
                <ArrowDown size={9} aria-hidden /> {summary.behind}
              </span>
            )}
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 text-faint" aria-hidden />
      </button>
      {branchPanel && (
        <ContextMenu
          x={branchPanel.x}
          y={branchPanel.y}
          width={260}
          items={branchPanelItems()}
          onClose={() => setBranchPanel(null)}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenuItems()}
          onClose={() => setRowMenu(null)}
        />
      )}
      <button
        disabled={busy !== null}
        onClick={() => void run("pull")}
        className="btn-ghost disabled:opacity-50"
      >
        {busy === "pull" ? (
          <LoaderCircle size={13} className="animate-spin" aria-hidden />
        ) : (
          <ArrowDownToLine size={13} aria-hidden />
        )}
        拉取
      </button>
      {/* 推送 = 分裂按钮：主体推上游，caret 选远程（多远程仓库需要） */}
      <div className="relative flex items-center">
        <button
          disabled={busy !== null}
          onClick={() => void run("push")}
          title={pushTarget ? `推送到 ${pushTarget}` : "推送（尚未建立上游关联）"}
          className="btn-ghost rounded-r-none border-r border-brd-soft disabled:opacity-50"
        >
          {busy === "push" ? (
            <LoaderCircle size={13} className="animate-spin" aria-hidden />
          ) : (
            <ArrowUpFromLine size={13} aria-hidden />
          )}
          推送
        </button>
        <button
          disabled={busy !== null || remotes.length === 0}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPushMenu({ x: r.left, y: r.bottom + 4 });
          }}
          title="选择推送目标远程"
          aria-label="选择推送目标远程"
          className="btn-ghost icon-btn rounded-l-none pl-0 disabled:opacity-50"
        >
          <ChevronDown size={11} aria-hidden />
        </button>
        {pushMenu && (
          <ContextMenu
            x={pushMenu.x}
            y={pushMenu.y}
            items={pushMenuItems()}
            onClose={() => setPushMenu(null)}
          />
        )}
      </div>
      <button
        disabled={busy !== null}
        onClick={() => void run("fetch")}
        className="btn-ghost disabled:opacity-50"
      >
        {busy === "fetch" ? (
          <LoaderCircle size={13} className="animate-spin" aria-hidden />
        ) : (
          <Download size={13} aria-hidden />
        )}
        抓取
      </button>
      <div className="ml-auto flex h-7 min-w-[200px] items-center gap-1.5 rounded-lg border border-brd bg-panel2 px-2.5 text-xs text-faint transition-colors focus-within:border-accent">
        <Search size={12} className="shrink-0" aria-hidden />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索提交信息 / 作者…"
          aria-label="搜索提交"
          className="w-full bg-transparent text-ink outline-none placeholder:text-faint"
        />
        {filter && (
          <button
            className="shrink-0 text-faint transition-colors hover:text-ink"
            aria-label="清空搜索"
            onClick={() => setFilter("")}
          >
            <X size={12} aria-hidden />
          </button>
        )}
      </div>
      <button
        className="btn-ghost icon-btn disabled:opacity-50"
        title="刷新"
        aria-label="刷新"
        disabled={refreshing}
        onClick={() => void doRefresh()}
      >
        {refreshing ? (
          <LoaderCircle size={13} className="animate-spin" aria-hidden />
        ) : (
          <RotateCw size={13} aria-hidden />
        )}
      </button>
      <button
        className="btn-ghost icon-btn"
        title={`主题：${mode === "dark" ? "深色" : mode === "light" ? "浅色" : "跟随系统"}`}
        aria-label="切换主题"
        onClick={() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])}
      >
        <ThemeIcon size={13} aria-hidden />
      </button>
      <button
        className="btn-ghost icon-btn"
        title="设置（字体 / 字号 / 缩放）"
        aria-label="设置"
        onClick={openSettings}
      >
        <Settings size={13} aria-hidden />
      </button>
    </div>
  );
}
