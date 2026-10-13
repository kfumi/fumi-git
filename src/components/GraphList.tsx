// 中央提交图谱列表：虚拟滚动行 + 视口 Canvas 曲线层（票 02/03）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitCommitHorizontal } from "lucide-react";
import { computeGraph, edgeCurve, graphWidth, laneX, windowCols, NODE_R, type Graph } from "../graph/lane";
import { filterCommits, useRepo } from "../stores/repo";
import { absTime, avatarColor, relTime } from "../lib/format";
import { classifyRef } from "../lib/refs";
import type { CommitEntry } from "../lib/types";
import { RefChips } from "./RefChips";
import { ContextMenu } from "./ContextMenu";
import {
  commitMenu as buildCommitMenu,
  detachedHead,
  type CommitMenuActions,
  type CommitTarget,
} from "../lib/menus";

export const ROW_H = 52;

function CanvasGraph({
  graph,
  rows,
  scrollTop,
  viewportH,
  cols,
  selectedId,
}: {
  graph: Graph;
  rows: CommitEntry[];
  scrollTop: number;
  viewportH: number;
  /** 视口内实际用到的列数（由 GraphList 算好传入，决定画布宽度） */
  cols: number;
  selectedId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = document.documentElement.dataset.mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const graphW = graphWidth(cols);
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

    // 连线：限幅贝塞尔。控制点离端点最多 BEND_MAX(38px)，所以跨多行的边
    // 绝大部分路程就是垂直直线，既不会像「控制点取中点」那样鼓成一团，
    // 也不需要 VS Code 那种行内正交走线的复杂模型。
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.8;
    for (const e of graph.edges) {
      if (e.r1 > lastRow || e.r2 < firstRow) continue;
      const c = edgeCurve(laneX(e.l1), y(e.r1), laneX(e.l2), y(e.r2));
      ctx.strokeStyle = e.color;
      // 父提交被过滤掉 → 虚线 stub，表示历史在可见范围之外继续
      ctx.setLineDash(e.pending ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(c.move[0], c.move[1]);
      ctx.bezierCurveTo(c.c1[0], c.c1[1], c.c2[0], c.c2[1], c.to[0], c.to[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 节点：一律空心圆环（底色填充盖住穿过的连线），选中时填充 accent
    for (let row = firstRow; row <= lastRow; row++) {
      const commit = rows[row];
      const node = graph.nodes.get(commit?.id ?? "");
      if (!node) continue;
      const isHead = commit.refs.includes("HEAD");
      const x = laneX(node.lane);
      const cy = y(row);
      if (isHead) {
        ctx.globalAlpha = 0.13;
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(x, cy, NODE_R * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = commit.id === selectedId ? accent : bg;
      ctx.strokeStyle = node.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, cy, NODE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [graph, rows, scrollTop, viewportH, cols, selectedId, mode]);

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
  const cherryPickFlow = useRepo((s) => s.cherryPickFlow);
  const revertFlow = useRepo((s) => s.revertFlow);
  const mergeBranchFlow = useRepo((s) => s.mergeBranchFlow);
  const summary = useRepo((s) => s.summary);
  const copyText = useRepo((s) => s.copyText);
  const copyCommitMessage = useRepo((s) => s.copyCommitMessage);
  const remotes = useRepo((s) => s.remotes);
  const createTagFlow = useRepo((s) => s.createTagFlow);
  const checkoutCommitFlow = useRepo((s) => s.checkoutCommitFlow);
  const compareWithHead = useRepo((s) => s.compareWithHead);
  const amendMessageFlow = useRepo((s) => s.amendMessageFlow);

  // 提交右键菜单：{ 位置, 目标 }；菜单项由 lib/menus.ts 单点构造（ui-spec §4）
  const [commitMenu, setCommitMenu] = useState<{
    x: number;
    y: number;
    target: CommitTarget;
  } | null>(null);

  // 动作包：菜单项由 lib/menus.ts 单点构造（ui-spec §4）；缺席的动作对应项不出现
  const menuActions: CommitMenuActions = {
    checkout: (b) => void checkout(b),
    mergeBranch: (ref) => void mergeBranchFlow(ref),
    createBranchFrom: (ref, label) => createBranchFlow({ ref, label }),
    copy: (text, label) => void copyText(text, label),
    showDetail: (id) => void select(id),
    copyCommitMessage: (id) => void copyCommitMessage(id),
    cherryPick: (id) => void cherryPickFlow(id),
    revert: (id) => void revertFlow(id),
    resetTo: (id) => resetBranchTo(id),
    createTag: (id) => createTagFlow(id),
    checkoutCommit: (id) => void checkoutCommitFlow(id),
    compareWithHead: (id) => void compareWithHead(id),
    amendMessage: (id) => amendMessageFlow(id),
  };

  const openCommitMenu = (e: React.MouseEvent, commit: CommitEntry) => {
    e.preventDefault();
    setCommitMenu({
      x: e.clientX,
      y: e.clientY,
      target: {
        id: commit.id,
        short: commit.short_id.slice(0, 7),
        branches: commit.refs.filter((r) => classifyRef(r, remotes) === "branch"),
        isHead: commit.refs.includes("HEAD"),
        currentBranch: detachedHead(summary) ? null : (summary?.branch ?? null),
      },
    });
  };

  const rows = useMemo(() => filterCommits(commits, filter), [commits, filter]);
  const graph = useMemo(() => computeGraph(rows), [rows]);

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

  // 列宽按**视口内实际用到的列数**算，而不是全局 laneCount：
  // 全局值是整份列表最宽的那处，直接用会在窄的地方留大片空白
  // （实测 20 分支仓库：全局 21 列，单个视口平均只用 13 列）。
  // 两侧各留 4 行缓冲，避免滚动时列宽频繁跳变。
  const viewCols = useMemo(() => {
    const rowCount = rows.length;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 2 - 4);
    const last = Math.min(rowCount - 1, Math.ceil((scrollTop + viewportH) / ROW_H) + 2 + 4);
    if (viewportH <= 0 || last < first) return Math.max(1, graph.laneCount);
    return windowCols(graph, first, last, (r) => rows[r]?.id);
  }, [graph, rows, scrollTop, viewportH]);

  const graphW = graphWidth(viewCols);

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
        cols={viewCols}
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
            onContextMenu={(e) => openCommitMenu(e, rows[vi.index])}
          />
        ))}
      </div>
      {commitMenu && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          items={buildCommitMenu(commitMenu.target, menuActions)}
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
        "absolute left-0 right-0 grid cursor-pointer grid-cols-[1fr_76px_70px_56px] items-center gap-[10px] overflow-hidden pr-[14px] transition-colors " +
        (selected ? "bg-sel-strong" : "hover:bg-hover")
      }
    >
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
