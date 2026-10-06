// 顶部动作栏：仓库、分支（↑↓ 计数）、远程动作、搜索、刷新、主题
import { useState } from "react";
import { useRepo } from "../stores/repo";
import { useTheme, THEME_LABELS } from "../theme";
import type { ThemeMode } from "../lib/types";

const MODES: ThemeMode[] = ["dark", "light", "system"];

export function Toolbar() {
  const meta = useRepo((s) => s.meta);
  const summary = useRepo((s) => s.summary);
  const filter = useRepo((s) => s.filter);
  const setFilter = useRepo((s) => s.setFilter);
  const remote = useRepo((s) => s.remote);
  const refresh = useRepo((s) => s.refresh);
  const toast = useRepo((s) => s.toast);
  const { mode, setMode } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);

  if (!meta) return null;

  const run = async (op: "fetch" | "pull" | "push") => {
    setBusy(op);
    await remote(op);
    setBusy(null);
  };

  const btn = (op: "fetch" | "pull" | "push", label: string) => (
    <button
      key={op}
      disabled={busy !== null}
      onClick={() => void run(op)}
      className="btn-ghost disabled:opacity-50"
    >
      {busy === op ? <span className="animate-spin">◌</span> : null}
      {label}
    </button>
  );

  return (
    <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-brd bg-panel px-3">
      <span className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="h-[7px] w-[7px] rounded-full bg-ok" />
        {meta.name}
      </span>
      <span className="flex h-7 items-center gap-2 rounded-lg border border-brd bg-panel2 px-3 text-xs font-medium">
        ⑂ {summary?.branch ?? meta.branch}
        {summary?.upstream && (summary.ahead > 0 || summary.behind > 0) && (
          <span className="text-[10.5px] font-normal">
            {summary.ahead > 0 && <span className="text-ok">↑{summary.ahead}</span>}
            {summary.behind > 0 && <span className="text-warn">↓{summary.behind}</span>}
          </span>
        )}
      </span>
      {btn("pull", "拉取")}
      {btn("push", "推送")}
      {btn("fetch", "抓取")}
      <div className="ml-auto flex h-7 min-w-[200px] items-center gap-1.5 rounded-lg border border-brd bg-panel2 px-2.5 text-xs text-faint">
        <span>🔍</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索提交信息 / 作者…"
          className="w-full bg-transparent text-ink outline-none placeholder:text-faint"
        />
        {filter && (
          <button className="text-faint hover:text-ink" onClick={() => setFilter("")}>
            ✕
          </button>
        )}
      </div>
      <button className="btn-ghost" title="刷新" onClick={() => void refresh()}>
        ⟳
      </button>
      <button
        className="btn-ghost"
        title="切换主题"
        onClick={() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])}
      >
        {mode === "dark" ? "🌙" : mode === "light" ? "☀️" : "◐"} {THEME_LABELS[mode]}
      </button>
      {toast && <ToastDot toast={toast} />}
    </div>
  );
}

function ToastDot({ toast }: { toast: { kind: string; text: string } }) {
  const color =
    toast.kind === "ok" ? "text-ok" : toast.kind === "err" ? "text-bad" : "text-dim animate-pulse";
  return (
    <span className={`max-w-[280px] truncate text-[11px] ${color}`} title={toast.text}>
      {toast.text}
    </span>
  );
}
