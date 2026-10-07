// 右上：提交详情（元信息 + 文件列表，点击文件 → 右下 diff tab）
// 中栏「改动」tab：工作区（暂存/提交）
import { useEffect, useState } from "react";
import { Check, CircleCheck, LoaderCircle } from "lucide-react";
import { useRepo } from "../stores/repo";
import { absTime, avatarColor } from "../lib/format";
import type { FileEntry, FileStat } from "../lib/types";
import { RefChips } from "./RefChips";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const ST_CLASS: Record<string, string> = {
  M: "bg-warn/15 text-warn",
  A: "bg-ok/15 text-ok",
  D: "bg-bad/15 text-bad",
  R: "bg-accent-soft text-accent-ink",
  U: "bg-bad/20 text-bad",
};

function StatusBadge({ s }: { s: string }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9.5px] font-semibold leading-none ${ST_CLASS[s] ?? ""}`}
      title={{ M: "修改", A: "新增", D: "删除", R: "重命名", U: "冲突" }[s]}
      aria-label={`状态 ${s}`}
    >
      {s}
    </span>
  );
}

export function CommitDetailPanel() {
  const detail = useRepo((s) => s.detail);
  const detailLoading = useRepo((s) => s.detailLoading);
  const detailFile = useRepo((s) => s.detailFile);
  const openDetailFile = useRepo((s) => s.openDetailFile);
  if (!detail)
    return (
      <div className="flex h-full items-center justify-center bg-panel text-xs text-faint">
        {detailLoading ? "加载详情…" : "选择一个提交查看详情"}
      </div>
    );
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
  const abortMerge = useRepo((s) => s.abortMerge);
  const discardWorktreeFlow = useRepo((s) => s.discardWorktreeFlow);
  const discardStagedFlow = useRepo((s) => s.discardStagedFlow);
  const discardAllFlow = useRepo((s) => s.discardAllFlow);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 多选（VS Code 源代码管理风格）：选择只在一个分组内；u:/s: 前缀区分同名文件
  const [selected, setSelected] = useState<{
    group: "staged" | "unstaged";
    paths: Set<string>;
  } | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  // 工作区文件行右键菜单：{ 位置, 文件, 所在分组 }
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    file: FileEntry;
    group: "staged" | "unstaged";
  } | null>(null);

  const rowKey = (group: "staged" | "unstaged", path: string) =>
    (group === "staged" ? "s:" : "u:") + path;

  const handleRowClick = (
    e: React.MouseEvent,
    file: FileEntry,
    group: "staged" | "unstaged",
    list: FileEntry[],
  ) => {
    const key = rowKey(group, file.path);
    // Ctrl/Cmd：toggle 所选（不开 diff）
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const base = prev && prev.group === group ? prev : { group, paths: new Set<string>() };
        const paths = new Set(base.paths);
        if (paths.has(key)) paths.delete(key);
        else paths.add(key);
        return paths.size ? { group, paths } : null;
      });
      setAnchor(key);
      return;
    }
    // Shift：组内范围选择（自上次锚点）
    if (e.shiftKey && anchor?.startsWith(group === "staged" ? "s:" : "u:")) {
      const idxA = list.findIndex((f) => rowKey(group, f.path) === anchor);
      const idxB = list.findIndex((f) => rowKey(group, f.path) === key);
      if (idxA >= 0 && idxB >= 0) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        const paths = new Set(list.slice(lo, hi + 1).map((f) => rowKey(group, f.path)));
        setSelected({ group, paths });
        return;
      }
    }
    // 普通点击：清空选择，保留「点击查看 diff」行为
    setSelected(null);
    setAnchor(key);
    void selectWorkFile(file.path, group === "staged");
  };

  // 状态刷新后修剪选择：已不在对应列表的文件移出所选
  useEffect(() => {
    if (!selected) return;
    const list = selected.group === "staged" ? status?.staged : status?.unstaged;
    const alive = new Set((list ?? []).map((f) => rowKey(selected.group, f.path)));
    const next = new Set([...selected.paths].filter((p) => alive.has(p)));
    if (next.size === 0) setSelected(null);
    else if (next.size !== selected.paths.size) setSelected({ group: selected.group, paths: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const rowMenuItems = (file: FileEntry, group: "staged" | "unstaged"): MenuItem[] => {
    const key = rowKey(group, file.path);
    // 右键的行在多选里 → 批量菜单（VS Code 行为：未选中的行则单选它）
    const multi =
      selected && selected.group === group && selected.paths.has(key) && selected.paths.size > 1;
    if (multi && status) {
      const files = (group === "staged" ? status.staged : status.unstaged).filter((f) =>
        selected.paths.has(rowKey(group, f.path)),
      );
      const n = files.length;
      const items: MenuItem[] = [];
      if (group === "staged") {
        items.push({
          label: `取消暂存所选（${n}）`,
          onSelect: () => {
            void unstage(files.map((f) => f.path));
            setSelected(null);
          },
        });
        items.push({
          label: `丢弃所选（${n}）…`,
          danger: true,
          onSelect: () => {
            discardStagedFlow(files);
            setSelected(null);
          },
        });
      } else {
        items.push({
          label: `暂存所选（${n}）`,
          onSelect: () => {
            void stage(files.map((f) => f.path));
            setSelected(null);
          },
        });
        items.push({
          label: `丢弃所选（${n}）…`,
          danger: true,
          onSelect: () => {
            discardWorktreeFlow(files);
            setSelected(null);
          },
        });
      }
      return items;
    }
    if (group === "staged") {
      return file.status === "A"
        ? [{ label: "丢弃新增文件…", danger: true, onSelect: () => discardStagedFlow([file]) }]
        : [
            {
              label: "丢弃改动（含暂存状态）…",
              danger: true,
              onSelect: () => discardStagedFlow([file]),
            },
          ];
    }
    // 未暂存组：状态 'A' = 未跟踪文件
    return file.status === "A"
      ? [{ label: "删除文件…", danger: true, onSelect: () => discardWorktreeFlow([file]) }]
      : [{ label: "丢弃改动…", danger: true, onSelect: () => discardWorktreeFlow([file]) }];
  };

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
  const total = status.staged.length + status.unstaged.length + status.unmerged.length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {status.merging && (
        <div className="flex shrink-0 items-center gap-2 border-b border-brd bg-warn-soft px-4 py-2 text-xs">
          <span className="font-medium text-warn">合并进行中</span>
          {status.unmerged.length > 0 && (
            <span className="text-dim">
              {status.unmerged.length} 个冲突文件，解决后暂存提交；或在终端处理后继续
            </span>
          )}
          <button
            onClick={() => void abortMerge()}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-bad transition-colors hover:bg-[rgba(242,112,138,0.10)]"
          >
            中止合并
          </button>
        </div>
      )}
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
          {status.unmerged.length > 0 && (
            <>
              <GroupLabel color="bg-bad" label="冲突" count={status.unmerged.length} />
              {status.unmerged.map((f) => (
                <WorkRow
                  key={"c" + f.path}
                  file={f}
                  active={workFile === f.path && !workStaged}
                  onSelect={() => void selectWorkFile(f.path, false)}
                  actionLabel="标记暂存"
                  onAction={() => void stage([f.path])}
                />
              ))}
            </>
          )}
          {status.staged.length > 0 && (
            <>
              <GroupLabel
                color="bg-ok"
                label="已暂存"
                count={status.staged.length}
                actionLabel="全部取消暂存"
                onAction={() => void unstage(status.staged.map((f) => f.path))}
              />
              {status.staged.map((f) => (
                <WorkRow
                  key={"s" + f.path}
                  file={f}
                  active={workFile === f.path && workStaged}
                  selected={!!selected && selected.group === "staged" && selected.paths.has(rowKey("staged", f.path))}
                  onSelect={(e) => handleRowClick(e, f, "staged", status.staged)}
                  actionLabel="取消暂存"
                  onAction={() => void unstage([f.path])}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const key = rowKey("staged", f.path);
                    if (!selected || selected.group !== "staged" || !selected.paths.has(key)) {
                      setSelected({ group: "staged", paths: new Set([key]) });
                    }
                    setAnchor(key);
                    setRowMenu({ x: e.clientX, y: e.clientY, file: f, group: "staged" });
                  }}
                />
              ))}
            </>
          )}
          {status.unstaged.length > 0 && (
            <>
              <GroupLabel
                color="bg-warn"
                label="未暂存"
                count={status.unstaged.length}
                actionLabel="全部暂存"
                onAction={() => void stage(status.unstaged.map((f) => f.path))}
              />
              {status.unstaged.map((f) => (
                <WorkRow
                  key={"u" + f.path}
                  file={f}
                  active={workFile === f.path && !workStaged}
                  selected={
                    !!selected &&
                    selected.group === "unstaged" &&
                    selected.paths.has(rowKey("unstaged", f.path))
                  }
                  onSelect={(e) => handleRowClick(e, f, "unstaged", status.unstaged)}
                  actionLabel="暂存"
                  onAction={() => void stage([f.path])}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const key = rowKey("unstaged", f.path);
                    if (!selected || selected.group !== "unstaged" || !selected.paths.has(key)) {
                      setSelected({ group: "unstaged", paths: new Set([key]) });
                    }
                    setAnchor(key);
                    setRowMenu({ x: e.clientX, y: e.clientY, file: f, group: "unstaged" });
                  }}
                />
              ))}
            </>
          )}
        </div>
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenuItems(rowMenu.file, rowMenu.group)}
          onClose={() => setRowMenu(null)}
        />
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
          {total > 0 && !status.merging && (
            <button
              onClick={() => discardAllFlow()}
              title="丢弃全部工作区改动（不可恢复）"
              className="text-[11px] text-bad transition-colors hover:opacity-80"
            >
              全部丢弃
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkRow({
  file,
  active,
  selected,
  onSelect,
  actionLabel,
  onAction,
  onContextMenu,
}: {
  file: FileEntry;
  active: boolean;
  /** 多选选中（bg-sel）；与 active（diff 查看中）可同时成立 */
  selected?: boolean;
  onSelect: (e: React.MouseEvent) => void;
  actionLabel: string;
  onAction: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors " +
        (selected || active ? "bg-sel" : "hover:bg-hover")
      }
    >
      <StatusBadge s={file.status} />
      <span
        className="truncate text-dim"
        title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}
      >
        {file.path}
      </span>
      {/* 悬停出现但始终占位（invisible→visible），避免出现/消失挤压路径文本造成行跳动 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        className="invisible ml-auto shrink-0 rounded px-1 py-0.5 text-[10.5px] text-faint transition-colors group-hover:visible hover:text-accent-ink"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function GroupLabel({
  color,
  label,
  count,
  actionLabel,
  onAction,
}: {
  color: string;
  label: string;
  count: number;
  /** 批量动作（悬停组头出现）：全部暂存 / 全部取消暂存 */
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="group sticky top-0 z-10 flex items-center gap-1.5 bg-panel px-2 pb-1 pt-2 text-[11px] font-medium text-dim">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />
      {label}
      <span className="tnum text-faint">{count}</span>
      {actionLabel && onAction && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          title={actionLabel}
          className="invisible ml-auto shrink-0 rounded px-1 py-0.5 text-[10.5px] font-normal text-faint transition-colors group-hover:visible hover:text-accent-ink"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
