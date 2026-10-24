// 右上：提交详情（元信息 + 文件列表，点击文件 → 右下 diff tab）
// 中栏「改动」tab：工作区（暂存/提交）
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleCheck, GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { useRepo, OPERATION_LABEL } from "../stores/repo";
import { ipc } from "../lib/ipc";
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

/** 已暂存/未暂存整块折叠的持久化键（折叠的组名集合） */
const COLLAPSED_GROUPS_KEY = "fumigit.collapsed-work-groups";

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]");
    return Array.isArray(raw) ? new Set(raw.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function StatusBadge({ s }: { s: string }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[0.59375rem] font-semibold leading-none ${ST_CLASS[s] ?? ""}`}
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
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-panel text-faint">
        {detailLoading ? (
          <LoaderCircle size={22} className="animate-spin" strokeWidth={1.5} aria-hidden />
        ) : (
          <GitCommitHorizontal size={22} strokeWidth={1.5} aria-hidden />
        )}
        <span className="text-xs">{detailLoading ? "加载详情…" : "选择一个提交查看详情"}</span>
      </div>
    );
  const meta = detail.meta;
  return (
    <div
      id="detail-panel"
      tabIndex={-1}
      className="select-text h-full min-h-0 overflow-y-auto bg-panel p-4 outline-none"
    >
      <h3 className="mb-2 text-sm font-semibold leading-relaxed">{meta.subject}</h3>
      {detail.body && (
        <p className="mb-2.5 whitespace-pre-wrap text-xs leading-relaxed text-dim">{detail.body}</p>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-dim">
        <span
          className="avatar flex h-5 w-5 items-center justify-center rounded-full text-[0.625rem] font-semibold text-white"
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
        <span className="tnum font-mono text-[0.6875rem] text-faint">{meta.short_id}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <RefChips refs={meta.refs} />
      </div>
      {meta.parents.length > 1 && (
        <p className="tnum mb-3 font-mono text-[0.6875rem] text-faint">
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
        <span className="max-w-[30%] shrink-0 truncate font-mono text-[0.6875rem] text-faint line-through">
          {file.old_path}
        </span>
      )}
      <span className="truncate font-mono text-[0.71875rem]">{file.path}</span>
      <span className="tnum ml-auto shrink-0 text-[0.65625rem]">
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
  const abortOperation = useRepo((s) => s.abortOperation);
  const continueOperationFlow = useRepo((s) => s.continueOperationFlow);
  const discardWorktreeFlow = useRepo((s) => s.discardWorktreeFlow);
  const discardStagedFlow = useRepo((s) => s.discardStagedFlow);
  const discardAllFlow = useRepo((s) => s.discardAllFlow);
  const openConflict = useRepo((s) => s.openConflict);
  const markResolvedFlow = useRepo((s) => s.markResolvedFlow);
  const conflictPath = useRepo((s) => s.conflictView?.path ?? null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 修正上一次提交（--amend）：勾选时若无输入则预填 HEAD 原信息；提交后自动复位
  const [amend, setAmend] = useState(false);
  // 已暂存/未暂存整块折叠；冲突组不折叠（操作进行中的紧迫态）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);
  const toggleGroup = (g: "staged" | "unstaged") =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      try {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // 持久化失败只影响下次启动的展开状态
      }
      return next;
    });
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

  // 勾选 amend：信息框为空时预填 HEAD 原信息（不覆盖已输入内容）；失败保持空白由用户自填
  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !message.trim()) {
      try {
        setMessage(await ipc.getLastCommitMessage());
      } catch {
        // 空仓库等取不到 HEAD 信息的情况，静默跳过
      }
    }
  };

  const doCommit = async () => {
    setSubmitting(true);
    const ok = await commit(message, amend);
    setSubmitting(false);
    if (ok) {
      setMessage("");
      setAmend(false);
    }
  };

  if (!status)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-panel text-faint">
        <LoaderCircle size={22} className="animate-spin" strokeWidth={1.5} aria-hidden />
        <span className="text-xs">加载工作区…</span>
      </div>
    );
  // amend 允许零暂存（纯信息修正）；普通提交必须有已暂存改动
  const canCommit = (amend || status.staged.length > 0) && message.trim().length > 0;
  const total = status.staged.length + status.unstaged.length + status.unmerged.length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {status.operation && (
        <div className="flex shrink-0 items-center gap-2 border-b border-brd bg-warn-soft px-4 py-2 text-xs">
          <span className="font-medium text-warn">{OPERATION_LABEL[status.operation].progress}</span>
          {status.unmerged.length > 0 ? (
            <span className="text-dim">
              {status.unmerged.length} 个冲突文件，点开处理后暂存提交；或中止操作
            </span>
          ) : (
            <span className="text-dim">冲突已全部标记解决</span>
          )}
          {status.unmerged.length === 0 && (
            <button
              onClick={() => void continueOperationFlow()}
              className="shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium text-accent-ink transition-colors hover:bg-hover"
            >
              {OPERATION_LABEL[status.operation].cont}
            </button>
          )}
          <button
            onClick={() => void abortOperation()}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] text-bad transition-colors hover:bg-bad-soft"
          >
            中止
          </button>
        </div>
      )}
      <div className="flex shrink-0 items-center justify-between px-4 pb-1.5 pt-3">
        <h4 className="text-[0.75rem] font-semibold text-ink">工作区</h4>
        {total > 0 && (
          <span className="tnum rounded-full bg-panel2 px-2 py-0.5 text-[0.65625rem] text-dim">
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
                  active={conflictPath === f.path}
                  onSelect={() => void openConflict(f.path)}
                  actionLabel="标记已解决"
                  onAction={() => void markResolvedFlow(f.path)}
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
                collapsed={collapsedGroups.has("staged")}
                onToggle={() => toggleGroup("staged")}
              />
              {!collapsedGroups.has("staged") && status.staged.map((f) => (
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
                collapsed={collapsedGroups.has("unstaged")}
                onToggle={() => toggleGroup("unstaged")}
              />
              {!collapsedGroups.has("unstaged") && status.unstaged.map((f) => (
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
        <div className="mt-1.5 flex items-center">
          <label
            className={
              "flex cursor-pointer items-center gap-1.5 text-[0.65625rem] transition-colors " +
              (amend ? "text-accent-ink" : "text-faint hover:text-dim")
            }
          >
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => void toggleAmend(e.target.checked)}
              className="accent-accent"
            />
            修正上一次提交
          </label>
          {amend && (
            <span className="ml-2 text-[0.65625rem] text-faint">已推送的提交修正后需强推</span>
          )}
        </div>
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
            {amend ? "修正上次提交" : `提交到 ${status.branch}`}
          </button>
          <span className="tnum ml-auto text-[0.6875rem] text-faint">
            {status.staged.length} 个已暂存
          </span>
          {total > 0 && !status.operation && (
            <button
              onClick={() => discardAllFlow()}
              title="丢弃全部工作区改动（不可恢复）"
              className="text-[0.6875rem] text-bad transition-colors hover:opacity-80"
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
        className="invisible ml-auto shrink-0 rounded px-1 py-0.5 text-[0.65625rem] text-faint transition-colors group-hover:visible hover:text-accent-ink"
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
  collapsed,
  onToggle,
}: {
  color: string;
  label: string;
  count: number;
  /** 批量动作（悬停组头出现）：全部暂存 / 全部取消暂存 */
  actionLabel?: string;
  onAction?: () => void;
  /** 整块折叠（已暂存/未暂存）；不传 onToggle = 永远展开（冲突组） */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const labelArea = (
    <>
      {onToggle ? (
        collapsed ? (
          <ChevronRight size={11} aria-hidden className="shrink-0 text-faint" />
        ) : (
          <ChevronDown size={11} aria-hidden className="shrink-0 text-faint" />
        )
      ) : (
        // 不可折叠的组（冲突）用隐身 chevron 占位，色点左缘对齐
        <ChevronRight size={11} aria-hidden className="invisible shrink-0" />
      )}
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} aria-hidden />
      <span>{label}</span>
      <span className="tnum text-faint">{count}</span>
    </>
  );
  return (
    <div className="group sticky top-0 z-10 flex items-center gap-1.5 bg-panel px-2 pb-1 pt-2 text-[0.6875rem] font-medium text-dim">
      {onToggle ? (
        <button
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-ink"
        >
          {labelArea}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{labelArea}</span>
      )}
      {actionLabel && onAction && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          title={actionLabel}
          className="invisible shrink-0 rounded px-1 py-0.5 text-[0.65625rem] font-normal text-faint transition-colors group-hover:visible hover:text-accent-ink"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
