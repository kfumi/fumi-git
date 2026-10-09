// 图谱 lane 分配与连线几何 —— 纯函数。
// 规则（定稿见 docs/design/ui-spec.md，对齐 oil-git 的 src/graph.ts）：
//   1. 节点列号优先**复用空槽位**，只记 max 水位、**不压缩下标**
//      → 同一条线列号全程稳定，不会在行间横移（旧实现 splice 压缩会横移）；
//   2. 节点出列即释放该槽，first parent 原地接棒，其余 parent 各占一列；
//   3. 连线为「限幅贝塞尔」：控制点离端点最多 BEND_MAX(38px)，
//      跨多行的边绝大部分路程即垂直直线，视觉上不会鼓成一团
//      （旧实现控制点取父子中点，跨度越大鼓包越夸张）；
//   4. 父提交不在可见集 → 虚线 stub 画到列表底部，占位列仍由 lanes 保留。

import type { CommitEntry } from "../lib/types";

/** 6 色（相邻位刻意拉开色相），按列号取色 —— 列稳定即颜色稳定 */
export const BRANCH_PALETTE = [
  "#7C7FF2",
  "#3ECFB2",
  "#F0A64B",
  "#B085F5",
  "#F2708A",
  "#4EA8F0",
];

export const LANE_STEP = 18;
export const GRAPH_PAD = 14;
/** 节点半径（外缘含描边约 11.6px，落在 18px 的列距里不粘连、也不显空） */
export const NODE_R = 5;
/** 贝塞尔控制点离端点的最大距离 */
export const BEND_MAX = 38;

export interface LaneNode {
  lane: number;
  color: string;
  row: number;
}

export interface LaneEdge {
  /** 起点行（子提交） */
  r1: number;
  l1: number;
  /** 终点行（父提交）；pending 时为 commits.length（列表底部之下） */
  r2: number;
  l2: number;
  color: string;
  /** 父提交不在可见集内 → 画虚线 stub */
  pending: boolean;
}

export interface Graph {
  nodes: Map<string, LaneNode>;
  edges: LaneEdge[];
  laneCount: number;
}

export function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_STEP;
}

/** 图谱列宽：随列数自适应（下限 96px） */
export function graphWidth(cols: number): number {
  return Math.max(96, (cols + 1) * LANE_STEP);
}

/**
 * 某段行区间内「有墨」的最大列号（返回列数）。
 *
 * 全局 laneCount 是整份列表里最宽的那处，直接拿来当列宽会在窄的地方留大片空白
 * （实测 20 分支仓库：全局 21 列，而单个视口平均只用 13 列）。
 *
 * 精确性：跨列的限幅贝塞尔会连续扫过 l1→l2 之间的所有 x，所以一条边在它跨越的
 * **每一行**上，有墨的最大列都恰为 max(l1, l2) —— 无需按行细分，直接按边取两端最大值即可。
 */
export function windowCols(
  graph: Graph,
  firstRow: number,
  lastRow: number,
  rowIds: (row: number) => string | undefined,
): number {
  let max = 0;
  for (const e of graph.edges) {
    if (e.r1 > lastRow || e.r2 < firstRow) continue;
    if (e.l1 > max) max = e.l1;
    if (e.l2 > max) max = e.l2;
  }
  for (let r = firstRow; r <= lastRow; r++) {
    const n = graph.nodes.get(rowIds(r) ?? "");
    if (n && n.lane > max) max = n.lane;
  }
  return max + 1;
}

export interface CurveCtl {
  move: [number, number];
  c1: [number, number];
  c2: [number, number];
  to: [number, number];
}

/**
 * 限幅贝塞尔控制点：bend = min(|Δy| * 0.45, BEND_MAX)。
 * 短边（相邻行）自然弯曲；长边只有首尾各 38px 在弯，中间几乎是直线。
 */
export function edgeCurve(x1: number, y1: number, x2: number, y2: number, bendMax = BEND_MAX): CurveCtl {
  const dy = y2 - y1;
  const bend = Math.min(Math.abs(dy) * 0.45, bendMax) * (dy >= 0 ? 1 : -1);
  return {
    move: [x1, y1],
    c1: [x1, y1 + bend],
    c2: [x2, y2 - bend],
    to: [x2, y2],
  };
}

export function computeGraph(commits: CommitEntry[]): Graph {
  const visible = new Set(commits.map((c) => c.id));
  const lanes: (string | null)[] = [];
  const nodes = new Map<string, LaneNode>();
  let maxLane = 0;

  // 找到 hash 已在等的列；否则优先复用空槽，最后才追加。**不回收压缩**，列号终身稳定。
  const reserve = (hash: string): number => {
    const found = lanes.indexOf(hash);
    if (found >= 0) return found;
    const free = lanes.indexOf(null);
    const lane = free >= 0 ? free : lanes.length;
    lanes[lane] = hash;
    return lane;
  };

  commits.forEach((c, row) => {
    const lane = reserve(c.id);
    if (lane > maxLane) maxLane = lane;
    nodes.set(c.id, { lane, color: BRANCH_PALETTE[lane % BRANCH_PALETTE.length], row });
    // 节点已出列 → 释放该槽，供 first parent 原地接棒或后续节点复用
    lanes[lane] = null;
    c.parents.forEach((parent, i) => {
      // 不可见的父提交**不占列**：否则它把槽位钉死到一个永远不会出现的 hash 上，
      // 搜索/过滤后每个被滤掉的 parent 都会永久泄漏一列（实测 11 列 → 47 列）。
      if (!visible.has(parent)) return;
      if (lanes.includes(parent)) return; // 已有列在等这个 parent
      if (i === 0 && lanes[lane] === null) lanes[lane] = parent;
      else {
        const l = reserve(parent);
        if (l > maxLane) maxLane = l;
      }
    });
  });

  // 边：子提交 lane → 父提交 lane；父提交不可见则沿本列画虚线 stub 到列表底部
  // （**不新开列**，只作「历史在可见范围外继续」的提示）
  const edges: LaneEdge[] = [];
  commits.forEach((c, row) => {
    const from = nodes.get(c.id)!;
    for (const p of c.parents) {
      const to = nodes.get(p);
      edges.push(
        to
          ? { r1: row, l1: from.lane, r2: to.row, l2: to.lane, color: from.color, pending: false }
          : { r1: row, l1: from.lane, r2: commits.length, l2: from.lane, color: from.color, pending: true },
      );
    }
  });

  return { nodes, edges, laneCount: maxLane + 1 };
}
