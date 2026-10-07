// 顶部动作栏：仓库、分支（↑↓ 计数）、远程动作、搜索、刷新、主题
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
  Sun,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { useRepo } from "../stores/repo";
import { useTheme } from "../theme";
import type { ThemeMode } from "../lib/types";

const MODES: ThemeMode[] = ["dark", "light", "system"];

const THEME_ICON: Record<ThemeMode, typeof Moon> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

export function Toolbar() {
  const meta = useRepo((s) => s.meta);
  const summary = useRepo((s) => s.summary);
  const filter = useRepo((s) => s.filter);
  const setFilter = useRepo((s) => s.setFilter);
  const remote = useRepo((s) => s.remote);
  const remotes = useRepo((s) => s.remotes);
  const pushToFlow = useRepo((s) => s.pushToFlow);
  const pushAllRemotesFlow = useRepo((s) => s.pushAllRemotesFlow);
  const refresh = useRepo((s) => s.refresh);
  const { mode, setMode } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 推送下拉：{ 锚点 }，菜单挂在 caret 按钮下方
  const [pushMenu, setPushMenu] = useState<{ x: number; y: number } | null>(null);

  if (!meta) return null;

  const run = async (op: "fetch" | "pull" | "push") => {
    setBusy(op);
    await remote(op);
    setBusy(null);
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
      <span className="flex items-center gap-2 pr-1.5 text-[13px] font-semibold">
        <span className="h-[7px] w-[7px] rounded-full bg-ok" />
        {meta.name}
      </span>
      <span className="flex h-7 items-center gap-1.5 rounded-lg border border-brd bg-panel2 px-2.5 text-xs font-medium">
        <GitBranch size={11} className="shrink-0 text-accent-ink" aria-hidden />
        {summary?.branch ?? meta.branch}
        {summary?.upstream && (summary.ahead > 0 || summary.behind > 0) && (
          <span className="tnum flex items-center gap-1 text-[10.5px] font-normal">
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
      </span>
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
    </div>
  );
}
