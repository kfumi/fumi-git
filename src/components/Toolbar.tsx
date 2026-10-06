// 顶部动作栏：仓库、分支（↑↓ 计数）、远程动作、搜索、刷新、主题
import { useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
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
  const refresh = useRepo((s) => s.refresh);
  const { mode, setMode } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  if (!meta) return null;

  const run = async (op: "fetch" | "pull" | "push") => {
    setBusy(op);
    await remote(op);
    setBusy(null);
  };

  const doRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const ops: { op: "fetch" | "pull" | "push"; label: string; Icon: typeof Download }[] = [
    { op: "pull", label: "拉取", Icon: ArrowDownToLine },
    { op: "push", label: "推送", Icon: ArrowUpFromLine },
    { op: "fetch", label: "抓取", Icon: Download },
  ];
  const ThemeIcon = THEME_ICON[mode];

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
      {ops.map(({ op, label, Icon }) => (
        <button
          key={op}
          disabled={busy !== null}
          onClick={() => void run(op)}
          className="btn-ghost disabled:opacity-50"
        >
          {busy === op ? (
            <LoaderCircle size={13} className="animate-spin" aria-hidden />
          ) : (
            <Icon size={13} aria-hidden />
          )}
          {label}
        </button>
      ))}
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
