// 中央提交图谱列表：虚拟滚动行 + 视口 Canvas 曲线层（票 02/03）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitCommitHorizontal } from "lucide-react";
import { computeGraph, graphWidth, laneX, type Graph } from "../graph/lane";
import { filterCommits, useRepo } from "../stores/repo";
import { absTime, avatarColor, relTime } from "../lib/format";
import { classifyRef } from "../lib/refs";
import type { CommitEntry } from "../lib/types";
import { RefChips } from "./RefChips";
import { ContextMenu, type MenuItem } from "./ContextMenu";

export const ROW_H = 52;

function CanvasGraph({
  graph,
  rows,
  scrollTop,
  viewportH,
  selectedId,
}: {
  graph: Graph;
  rows: CommitEntry[];
  scrollTop: number;
  viewportH: number;
  selectedId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = document.documentElement.dataset.mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const graphW = graphWidth(graph.laneCount);
    canvas.width = graphW * dpr;
    canvas.height = Math.max(viewportH, 1) * dpr;
    canvas.style.width = `${graphW}px`;
    canvas.style.height = `${Math.max(viewportH, 1)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const style = getComputedStyle(document.documentElement);
    const bg = style.getPropertyValue("--bg").trim() || "#0C0D11";
    const accent = style.getPropertyValue("--accent").trim() || "#7C7FF2";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, graphW, viewportH);

    const rowCount = rows.length;
    const y = (row: number) => row * ROW_H + ROW_H / 2 - scrollTop;
    const firstRow = Math.max(0, Math.floor(scrollTop / ROW_H) - 2);
    const lastRow = Math.min(rowCount - 1, Math.ceil((scrollTop + viewportH) / ROW_H) + 2);

    // 曲线（子在上，父在下：r2 > r1）
    ctx.lineWidth = 1.6;
    for (const e of graph.edges) {
      if (e.r1 > lastRow || e.r2 < firstRow) continue;
      const x1 = laneX(e.l1);
      const x2 = laneX(e.l2);
      const y1 = y(e.r1);
      const y2 = y(e.r2);
      const my = (y1 + y2) / 2;
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, my, x2, my, x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 节点
    for (let row = firstRow; row <= lastRow; row++) {
      const node = graph.nodes.get(rows[row]?.id ?? "");
      if (!node) continue;
      const isHead = rows[row].refs.includes("HEAD");
      const x = laneX(node.lane);
      const cy = y(row);
      ctx.beginPath();
      ctx.arc(x, cy, isHead ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = bg;
      ctx.stroke();
      if (rows[row].id === selectedId) {
        ctx.beginPath();
        ctx.arc(x, cy, 8.5, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
  }, [graph, rows, scrollTop, viewportH, selectedId, mode]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "sticky",
        top: 0,
        left: 0,
        zIndex: 0,
        pointerEvents: "none",
        display: "block",
      }}
    />
  );
}

export function GraphList() {
  const commits = useRepo((s) => s.commits);
  const filter = useRepo((s) => s.filter);
  const selectedId = useRepo((s) => s.selectedId);
  const select = useRepo((s) => s.select);
  const loadMore = useRepo((s) => s.loadMore);
  const scrollToId = useRepo((s) => s.scrollToId);
  const scrollNonce = useRepo((s) => s.scrollNonce);
  const checkout = useRepo((s) => s.checkout);
  const createBranchFlow = useRepo((s) => s.createBranchFlow);
  const resetBranchTo = useRepo((s) => s.resetBranchTo);
  // 提交右键菜单：挂本地分支才出现迁出项（ui-spec 决策：不做 detached HEAD）
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; commit: CommitEntry } | null>(
    null,
  );

  const commitMenuItems = (commit: CommitEntry): MenuItem[] => {
    const branches = commit.refs.filter((r) => classifyRef(r) === "branch");
    const items: MenuItem[] = branches.map((b) => ({
      label: `迁出到 ${b}`,
      disabled: b === useRepo.getState().summary?.branch,
      hint: b === useRepo.getState().summary?.branch ? "当前分支" : undefined,
      onSelect: () => void checkout(b),
    }));
    items.push(
      { label: "在此新建分支…", onSelect: () => createBranchFlow(commit.id) },
      {
        label: "重置当前分支到此…",
        onSelect: () => resetBranchTo(commit.id),
      },
    );
    return items;
  };

  const rows = useMemo(() => filterCommits(commits, filter), [commits, filter]);
  const graph = useMemo(() => computeGraph(rows), [rows]);
  const graphW = graphWidth(graph.laneCount);

  // 侧栏点击分支/标签/远程 → 将其 tip 提交滚动到列表顶部（行高恒定，直接换算 scrollTop）
  useEffect(() => {
    if (!scrollToId || !scrollNonce) return;
    const idx = rows.findIndex((r) => r.id === scrollToId);
    const el = scrollRef.current;
    if (idx >= 0 && el) el.scrollTop = idx * ROW_H;
    // 只在显式点击引用时触发，不随 rows 变化重滚
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollNonce]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const rafRef = useRef(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const onScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight);
      if (el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 20) {
        void loadMore();
      }
    });
  }, [loadMore]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    e.preventDefault();
    if (e.key === "Enter") {
      (document.getElementById("detail-panel") as HTMLElement | null)?.focus();
      return;
    }
    const idx = rows.findIndex((c) => c.id === selectedId);
    const next =
      e.key === "ArrowDown"
        ? Math.min(rows.length - 1, idx + 1)
        : Math.max(0, idx <= 0 ? 0 : idx - 1);
    if (rows.length && next !== idx) {
      select(rows[next].id);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  return (
    <div
      ref={scrollRef}
      className="relative h-full min-h-0 overflow-y-auto outline-none"
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      aria-label="提交图谱"
    >
      <CanvasGraph
        graph={graph}
        rows={rows}
        scrollTop={scrollTop}
        viewportH={viewportH}
        selectedId={selectedId}
      />
      <div
        style={{
          height: virtualizer.getTotalSize(),
          marginTop: -Math.max(viewportH, 1),
          position: "relative",
          zIndex: 1,
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => (
          <CommitRow
            key={rows[vi.index].id}
            commit={rows[vi.index]}
            selected={rows[vi.index].id === selectedId}
            top={vi.start}
            graphW={graphW}
            onSelect={() => select(rows[vi.index].id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCommitMenu({ x: e.clientX, y: e.clientY, commit: rows[vi.index] });
            }}
          />
        ))}
      </div>
      {commitMenu && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          items={commitMenuItems(commitMenu.commit)}
          onClose={() => setCommitMenu(null)}
        />
      )}
      {rows.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-2 text-center text-faint">
          <GitCommitHorizontal size={22} strokeWidth={1.5} aria-hidden />
          <span className="text-xs">{filter ? "没有匹配的提交" : "这个仓库还没有提交"}</span>
        </div>
      )}
    </div>
  );
}

function CommitRow({
  commit,
  selected,
  top,
  graphW,
  onSelect,
  onContextMenu,
}: {
  commit: CommitEntry;
  selected: boolean;
  top: number;
  graphW: number;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      style={{ top, height: ROW_H, paddingLeft: graphW + 16 }}
      className={
        "absolute left-0 right-0 grid cursor-pointer grid-cols-[1fr_92px_70px_56px] items-center gap-[10px] overflow-hidden pr-[14px] transition-colors " +
        (selected ? "bg-sel" : "hover:bg-hover")
      }
    >
      {selected && <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-accent" />}
      {/* IDEA 式两行：主题独占一行；ref 徽章固定第二行（无引用时不占位，不再与标题互相挤压） */}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium leading-[18px]" title={commit.subject}>
          {commit.subject}
        </div>
        {commit.refs.length > 0 && (
          <div className="mt-1 flex items-center overflow-hidden whitespace-nowrap">
            <RefChips refs={commit.refs} max={4} />
          </div>
        )}
      </div>
      <div
        className="flex min-w-0 items-center gap-1.5 text-xs text-dim"
        title={commit.author_name}
      >
        <span
          className="avatar flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ background: avatarColor(commit.author_name) }}
          aria-hidden
        >
          {commit.author_name.slice(0, 1)}
        </span>
        <span className="truncate">{commit.author_name}</span>
      </div>
      <div className="tnum truncate text-right text-[11.5px] text-faint" title={absTime(commit.time)}>
        {relTime(commit.time)}
      </div>
      <div className="tnum truncate text-right font-mono text-[11.5px] text-faint" title={commit.id}>
        {commit.short_id}
      </div>
    </div>
  );
}
