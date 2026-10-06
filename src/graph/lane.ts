// 图谱 lane 分配 —— 纯函数，从已归档原型（分支 prototype/ui-variants）移植。
// 规则（定稿见 docs/design/ui-spec.md / spec）：
//   按传入顺序（拓扑序，children 在 parent 前）遍历；
//   first parent 延续本 lane，不在可见集内则 lane 立即回收；
//   其余 parent 各开新 lane（分支调色板按序取色）；
//   无主的 lane 立即回收压缩。

import type { CommitEntry } from "../lib/types";

export const BRANCH_PALETTE = [
  "#7C7FF2",
  "#3ECFB2",
  "#F0A64B",
  "#F2708A",
  "#B085F5",
  "#4EA8F0",
  "#5ADFC4",
  "#F6BC6E",
];

export const LANE_STEP = 15;
export const GRAPH_PAD = 14;

export interface LaneNode {
  lane: number;
  color: string;
  row: number;
}

export interface LaneEdge {
  /** 起点行（子提交） */
  r1: number;
  l1: number;
  /** 终点行（父提交） */
  r2: number;
  l2: number;
  color: string;
}

export interface Graph {
  nodes: Map<string, LaneNode>;
  edges: LaneEdge[];
  laneCount: number;
}

export function laneX(lane: number): number {
  return GRAPH_PAD / 2 + 8 + lane * LANE_STEP;
}

export function computeGraph(commits: CommitEntry[]): Graph {
  const visible = new Set(commits.map((c) => c.id));
  const lanes: (string | null)[] = [];
  const laneColors: string[] = [];
  let colorSeq = 0;
  const nodes = new Map<string, LaneNode>();
  const edges: LaneEdge[] = [];

  commits.forEach((c, row) => {
    let lane = lanes.indexOf(c.id);
    if (lane === -1) lane = lanes.length;
    const color = laneColors[lane] ?? BRANCH_PALETTE[colorSeq++ % BRANCH_PALETTE.length];
    laneColors[lane] = color;
    nodes.set(c.id, { lane, color, row });

    const [p0, ...rest] = c.parents;
    lanes[lane] = p0 && visible.has(p0) ? p0 : null;
    for (const p of rest) {
      if (!visible.has(p)) continue;
      if (lanes.indexOf(p) === -1) {
        lanes.push(p);
        laneColors.push(BRANCH_PALETTE[colorSeq++ % BRANCH_PALETTE.length]);
      }
    }
    // 回收空 lane
    for (let i = lanes.length - 1; i >= 0; i--) {
      if (lanes[i] === null) {
        lanes.splice(i, 1);
        laneColors.splice(i, 1);
      }
    }
  });

  // 边：子提交 lane → 父提交 lane（父提交必须可见）
  commits.forEach((c, row) => {
    const from = nodes.get(c.id);
    if (!from) return;
    for (const p of c.parents) {
      const to = nodes.get(p);
      if (to) edges.push({ r1: row, l1: from.lane, r2: to.row, l2: to.lane, color: from.color });
    }
  });

  return { nodes, edges, laneCount: Math.max(1, lanes.length, ...[...nodes.values()].map((n) => n.lane + 1)) };
}
