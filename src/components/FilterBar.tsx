// 图谱筛选（ui-spec §1）：分支 / 提交者 / 日期三块下拉 + 清除筛选。
//
// 渲染在**工具栏搜索框左侧**（与搜索同排），组件本身只是这三个按钮的片段，不带行容器——
// 所以它随工具栏常驻，与中栏 tab 无关（筛选是仓库级状态，改动 tab 下同样有效）。
// 条目、勾选态与文案由 lib/filterMenu.ts 单点定义（同 §4 对右键菜单的要求）。
// 三块筛选一律下推 git（get_log 的 LogFilter），与搜索框的客户端子串过滤正交：
// 搜索过滤「已加载的」，筛选改变「加载什么」。
import { useMemo, useRef, useState } from "react";
import { ChevronDown, ListX } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import {
  authorPattern,
  filterButtonLabels,
  filterMenuItems,
  logFilterActive,
  type FilterMenuKey,
  type FilterPick,
} from "../lib/filterMenu";
import { useRepo } from "../stores/repo";

export function FilterBar() {
  const logFilter = useRepo((s) => s.logFilter);
  const setLogFilter = useRepo((s) => s.setLogFilter);
  const resetLogFilters = useRepo((s) => s.resetLogFilters);
  const identity = useRepo((s) => s.identity);
  const authorStats = useRepo((s) => s.authorStats);
  const refs = useRepo((s) => s.refs);
  const [open, setOpen] = useState<FilterMenuKey | null>(null);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const anchorRef = useRef<HTMLElement | null>(null);
  // 提交者块底部输入框的草稿：打开菜单时回填当前自定义筛选（「只看我的」不回填，它不是手输的）
  const [draft, setDraft] = useState("");

  // 分支筛选只列本地分支（远程 ref / 标签不作为筛选维度）
  const branches = useMemo(
    () =>
      refs
        .filter((r) => r.kind === "branch")
        .map((r) => r.name)
        .sort((a, b) => a.localeCompare(b)),
    [refs],
  );
  const labels = filterButtonLabels(logFilter, identity);
  const mine = authorPattern(identity);

  const toggle = (key: FilterMenuKey, e: React.MouseEvent<HTMLButtonElement>) => {
    if (open === key) {
      setOpen(null);
      return;
    }
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    anchorRef.current = el;
    setAnchor({ x: r.left, y: r.bottom + 4 });
    if (key === "author") {
      setDraft(logFilter.author && logFilter.author !== mine ? logFilter.author : "");
    }
    setOpen(key);
  };

  const pick: FilterPick = (patch) => void setLogFilter(patch);

  return (
    <>
      <FilterButton
        label={`分支：${labels.branch}`}
        active={logFilter.branch !== null}
        onClick={(e) => toggle("branch", e)}
      />
      <FilterButton
        label={`提交者：${labels.author}`}
        active={logFilter.author !== null}
        onClick={(e) => toggle("author", e)}
      />
      <FilterButton
        label={`日期：${labels.date}`}
        active={logFilter.since !== null}
        onClick={(e) => toggle("date", e)}
      />
      {/* 有筛选在生效才占位：一眼看出「我看的不是全量」并给一键回默认 */}
      {logFilterActive(logFilter) && (
        <button
          title="清除筛选"
          aria-label="清除筛选"
          onClick={() => void resetLogFilters()}
          className="btn-ghost icon-btn"
        >
          <ListX size={13} aria-hidden />
        </button>
      )}
      {open && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          items={filterMenuItems(open, { logFilter, branches, identity, authorStats }, pick)}
          onClose={() => setOpen(null)}
          anchor={anchorRef}
          maxListH={open === "date" ? undefined : open === "branch" ? 320 : 264}
          footer={
            open === "author" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = draft.trim();
                  void setLogFilter({ author: v ? v : null });
                  setOpen(null); // 回车即过滤并收起下拉，让结果立刻可见
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="输入姓名或邮箱，回车过滤…"
                  aria-label="按提交者过滤"
                  className="w-[190px] bg-transparent text-xs text-ink outline-none placeholder:text-faint"
                />
              </form>
            ) : undefined
          }
        />
      )}
    </>
  );
}

function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-haspopup="menu"
      // 窄窗口下允许收缩：标签截断，不许把搜索框挤出去
      className={
        "flex h-7 min-w-0 shrink items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors " +
        (active
          ? "border-accent bg-accent-soft font-medium text-accent-ink"
          : "border-brd bg-panel2 text-dim hover:text-ink")
      }
    >
      <span className="max-w-[160px] truncate">{label}</span>
      <ChevronDown size={11} aria-hidden className="shrink-0 opacity-70" />
    </button>
  );
}
