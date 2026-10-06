// 右侧：提交详情（元信息 + 文件列表 + diff）与工作区（暂存/提交）
import { useEffect, useState } from "react";
import { useRepo } from "../stores/repo";
import { absTime, avatarColor } from "../lib/format";
import type { FileStat } from "../lib/types";
import { RefChips } from "./RefChips";
import { DetailDiff } from "./DiffView";

const ST_CLASS: Record<string, string> = {
  M: "bg-warn/15 text-warn",
  A: "bg-ok/15 text-ok",
  D: "bg-bad/15 text-bad",
  R: "bg-accent-soft text-accent-ink",
};

function StatusBadge({ s }: { s: string }) {
  return (
    <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[9.5px] font-bold ${ST_CLASS[s] ?? ""}`}>
      {s}
    </span>
  );
}

export function CommitDetailPanel() {
  const detail = useRepo((s) => s.detail);
  const loading = useRepo((s) => s.detailLoading);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  useEffect(() => {
    setActiveFile(null); // 换提交后回到第一个文件
  }, [detail?.meta.id]);
  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-hidden border-b border-brd bg-panel text-xs text-faint">
        在左侧选择一个提交查看详情
      </div>
    );
  }
  const meta = detail.meta;
  return (
    <div
      id="detail-panel"
      tabIndex={-1}
      className="min-h-0 flex-[1.3] overflow-y-auto border-b border-brd bg-panel p-4 outline-none"
    >
      <h3 className="mb-2 text-sm font-semibold leading-relaxed">{meta.subject}</h3>
      {detail.body && <p className="mb-2.5 whitespace-pre-wrap text-xs leading-relaxed text-dim">{detail.body}</p>}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-dim">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ background: avatarColor(meta.author_name) }}
        >
          {meta.author_name.slice(0, 1)}
        </span>
        <span>{meta.author_name}</span>
        <span>·</span>
        <span title={absTime(meta.time)}>{absTime(meta.time)}</span>
        <span>·</span>
        <span className="font-mono text-[11px] text-faint">{meta.short_id}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <RefChips refs={meta.refs} />
      </div>
      {meta.parents.length > 1 && (
        <p className="mb-3 font-mono text-[11px] text-faint">
          父提交：{meta.parents.map((p) => p.slice(0, 7)).join("、")}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-brd">
        {detail.files.map((f) => (
          <FileRow
            key={f.path + (f.old_path ?? "")}
            file={f}
            active={activeFile === f.path || (activeFile === null && f === detail.files[0])}
            onClick={() => setActiveFile(f.path)}
          />
        ))}
      </div>
      {loading ? (
        <p className="mt-3 text-xs text-faint">加载 diff…</p>
      ) : (
        <div className="mt-3">
          <DetailDiff detail={detail} selectedFile={activeFile ?? detail.files[0]?.path ?? null} />
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  active,
  onClick,
}: {
  file: FileStat;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={
        "flex cursor-pointer items-center gap-2 border-b border-brd px-3 py-[7px] text-xs last:border-b-0 " +
        (active ? "bg-sel" : "bg-panel2 hover:bg-hover")
      }
    >
      <StatusBadge s={file.status} />
      {file.old_path && (
        <span className="max-w-[30%] shrink-0 truncate font-mono text-[11px] text-faint line-through">
          {file.old_path}
        </span>
      )}
      <span className="truncate font-mono text-[11.5px]">{file.path}</span>
      <span className="ml-auto shrink-0 text-[10.5px]">
        {file.binary ? (
          <span className="text-faint">二进制</span>
        ) : (
          <>
            <span className="text-ok">+{file.add}</span> <span className="text-bad">−{file.del}</span>
          </>
        )}
      </span>
    </div>
  );
}

export function StagePanel() {
  const status = useRepo((s) => s.status);
  const stage = useRepo((s) => s.stage);
  const unstage = useRepo((s) => s.unstage);
  const commit = useRepo((s) => s.commit);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.ctrlKey && message.trim() && !submitting) {
        void doCommit();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const doCommit = async () => {
    setSubmitting(true);
    const ok = await commit(message);
    setSubmitting(false);
    if (ok) setMessage("");
  };

  if (!status) return null;
  const canCommit = status.staged.length > 0 && message.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="px-4 pb-1.5 pt-2 text-[11px] font-semibold tracking-wide text-faint">
        工作区 — {status.staged.length + status.unstaged.length} 个文件
      </div>
      <div className="min-h-[40px] flex-1 overflow-y-auto px-2">
        <div className="px-2 pb-1 pt-1 text-[11px] text-ok">已暂存 {status.staged.length}</div>
        {status.staged.map((f) => (
          <div key={"s" + f.path} className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover">
            <StatusBadge s={f.status} />
            <span className="truncate text-dim" title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}>
              {f.path}
            </span>
            <button
              onClick={() => void unstage([f.path])}
              className="ml-auto hidden shrink-0 text-[10.5px] text-faint hover:text-ink group-hover:block"
            >
              取消暂存
            </button>
          </div>
        ))}
        <div className="px-2 pb-1 pt-2 text-[11px] text-warn">未暂存 {status.unstaged.length}</div>
        {status.unstaged.map((f) => (
          <div key={"u" + f.path} className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover">
            <StatusBadge s={f.status} />
            <span className="truncate text-dim" title={f.path}>
              {f.path}
            </span>
            <button
              onClick={() => void stage([f.path])}
              className="ml-auto hidden shrink-0 text-[10.5px] text-faint hover:text-accent-ink group-hover:block"
            >
              暂存
            </button>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-brd p-3">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="提交信息（Ctrl+Enter 提交）"
          className="h-11 w-full resize-none rounded-lg border border-brd bg-panel2 px-2.5 py-2 text-xs text-ink outline-none focus:border-accent"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={!canCommit || submitting}
            onClick={() => void doCommit()}
            className="h-7 rounded-lg bg-accent px-3 text-xs font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ✓ 提交到 {status.branch}
          </button>
          <span className="ml-auto text-[11px] text-faint">
            {status.staged.length} 个已暂存
          </span>
        </div>
      </div>
    </div>
  );
}
