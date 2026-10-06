// 右上：提交详情（元信息 + 文件列表，点击文件 → 右下 diff tab）
// 中栏「改动」tab：工作区（暂存/提交）
import { useEffect, useState } from "react";
import { Check, CircleCheck, LoaderCircle } from "lucide-react";
import { useRepo } from "../stores/repo";
import { absTime, avatarColor } from "../lib/format";
import type { FileEntry, FileStat } from "../lib/types";
import { RefChips } from "./RefChips";

const ST_CLASS: Record<string, string> = {
  M: "bg-warn/15 text-warn",
  A: "bg-ok/15 text-ok",
  D: "bg-bad/15 text-bad",
  R: "bg-accent-soft text-accent-ink",
};

function StatusBadge({ s }: { s: string }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9.5px] font-semibold leading-none ${ST_CLASS[s] ?? ""}`}
      title={{ M: "修改", A: "新增", D: "删除", R: "重命名" }[s]}
      aria-label={`状态 ${s}`}
    >
      {s}
    </span>
  );
}

export function CommitDetailPanel() {
  const detail = useRepo((s) => s.detail);
  const detailFile = useRepo((s) => s.detailFile);
  const openDetailFile = useRepo((s) => s.openDetailFile);
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center overflow-hidden bg-panel text-xs text-faint">
        在左侧选择一个提交查看详情
      </div>
    );
  }
  const meta = detail.meta;
  return (
    <div
      id="detail-panel"
      tabIndex={-1}
      className="h-full min-h-0 overflow-y-auto bg-panel p-4 outline-none"
    >
      <h3 className="mb-2 text-sm font-semibold leading-relaxed">{meta.subject}</h3>
      {detail.body && (
        <p className="mb-2.5 whitespace-pre-wrap text-xs leading-relaxed text-dim">{detail.body}</p>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-dim">
        <span
          className="avatar flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ background: avatarColor(meta.author_name) }}
          aria-hidden
        >
          {meta.author_name.slice(0, 1)}
        </span>
        <span>{meta.author_name}</span>
        <span className="text-faint">·</span>
        <span className="tnum" title={absTime(meta.time)}>
          {absTime(meta.time)}
        </span>
        <span className="text-faint">·</span>
        <span className="tnum font-mono text-[11px] text-faint">{meta.short_id}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <RefChips refs={meta.refs} />
      </div>
      {meta.parents.length > 1 && (
        <p className="tnum mb-3 font-mono text-[11px] text-faint">
          父提交：{meta.parents.map((p) => p.slice(0, 7)).join("、")}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-brd bg-panel2">
        {detail.files.map((f) => (
          <FileRow
            key={f.path + (f.old_path ?? "")}
            file={f}
            active={f.path === detailFile}
            onClick={() => openDetailFile(f.path)}
          />
        ))}
      </div>
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
        "flex cursor-pointer items-center gap-2 border-b border-brd-soft px-3 py-[7px] text-xs last:border-b-0 transition-colors " +
        (active ? "bg-sel" : "hover:bg-hover")
      }
    >
      <StatusBadge s={file.status} />
      {file.old_path && (
        <span className="max-w-[30%] shrink-0 truncate font-mono text-[11px] text-faint line-through">
          {file.old_path}
        </span>
      )}
      <span className="truncate font-mono text-[11.5px]">{file.path}</span>
      <span className="tnum ml-auto shrink-0 text-[10.5px]">
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

// 中栏「改动」tab：工作区文件分组 + 暂存/提交操作（原右下面板整体迁入）
// 点击文件行 → 右栏展示该文件的工作区 diff
export function ChangesPanel() {
  const status = useRepo((s) => s.status);
  const stage = useRepo((s) => s.stage);
  const unstage = useRepo((s) => s.unstage);
  const commit = useRepo((s) => s.commit);
  const selectWorkFile = useRepo((s) => s.selectWorkFile);
  const workFile = useRepo((s) => s.workFile);
  const workStaged = useRepo((s) => s.workStaged);
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

  if (!status)
    return (
      <div className="flex h-full items-center justify-center bg-panel text-xs text-faint">
        加载工作区…
      </div>
    );
  const canCommit = status.staged.length > 0 && message.trim().length > 0;
  const total = status.staged.length + status.unstaged.length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 items-center justify-between px-4 pb-1.5 pt-3">
        <h4 className="text-[12px] font-semibold text-ink">工作区</h4>
        {total > 0 && (
          <span className="tnum rounded-full bg-panel2 px-2 py-0.5 text-[10.5px] text-dim">
            {total} 个文件
          </span>
        )}
      </div>
      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-16 text-faint">
          <CircleCheck size={22} className="text-ok" aria-hidden />
          <p className="text-xs">工作区是干净的</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {status.staged.length > 0 && (
            <>
              <GroupLabel color="bg-ok" label="已暂存" count={status.staged.length} />
              {status.staged.map((f) => (
                <WorkRow
                  key={"s" + f.path}
                  file={f}
                  active={workFile === f.path && workStaged}
                  onSelect={() => void selectWorkFile(f.path, true)}
                  actionLabel="取消暂存"
                  onAction={() => void unstage([f.path])}
                />
              ))}
            </>
          )}
          {status.unstaged.length > 0 && (
            <>
              <GroupLabel color="bg-warn" label="未暂存" count={status.unstaged.length} />
              {status.unstaged.map((f) => (
                <WorkRow
                  key={"u" + f.path}
                  file={f}
                  active={workFile === f.path && !workStaged}
                  onSelect={() => void selectWorkFile(f.path, false)}
                  actionLabel="暂存"
                  onAction={() => void stage([f.path])}
                />
              ))}
            </>
          )}
        </div>
      )}
      <div className="shrink-0 border-t border-brd p-3">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="提交信息（Ctrl+Enter 提交）"
          className="h-14 w-full resize-none rounded-lg border border-brd bg-panel2 px-2.5 py-2 text-xs text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={!canCommit || submitting}
            onClick={() => void doCommit()}
            className="btn-primary"
          >
            {submitting ? (
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            ) : (
              <Check size={13} aria-hidden />
            )}
            提交到 {status.branch}
          </button>
          <span className="tnum ml-auto text-[11px] text-faint">
            {status.staged.length} 个已暂存
          </span>
        </div>
      </div>
    </div>
  );
}

function WorkRow({
  file,
  active,
  onSelect,
  actionLabel,
  onAction,
}: {
  file: FileEntry;
  active: boolean;
  onSelect: () => void;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors " +
        (active ? "bg-sel" : "hover:bg-hover")
      }
    >
      <StatusBadge s={file.status} />
      <span
        className="truncate text-dim"
        title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}
      >
        {file.path}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        className="ml-auto hidden shrink-0 rounded px-1 py-0.5 text-[10.5px] text-faint transition-colors hover:text-accent-ink group-hover:block"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function GroupLabel({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-panel px-2 pb-1 pt-2 text-[11px] font-medium text-dim">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />
      {label}
      <span className="tnum text-faint">{count}</span>
    </div>
  );
}
