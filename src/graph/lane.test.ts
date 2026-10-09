import { describe, expect, it } from "vitest";
import {
  computeGraph,
  edgeCurve,
  graphWidth,
  laneX,
  windowCols,
  BRANCH_PALETTE,
  BEND_MAX,
  LANE_STEP,
  NODE_R,
} from "./lane";
import type { CommitEntry } from "../lib/types";

let seq = 0;
const c = (id: string, parents: string[] = [], refs: string[] = []): CommitEntry => ({
  id,
  short_id: id.slice(0, 7),
  parents,
  author_name: "t",
  author_email: "t@t",
  time: seq++,
  subject: id,
  refs,
});

const lanesOf = (g: ReturnType<typeof computeGraph>, ids: string[]) =>
  ids.map((id) => g.nodes.get(id)!.lane);

describe("computeGraph", () => {
  it("线性历史：全部占 lane 0", () => {
    const g = computeGraph([c("c", ["b"]), c("b", ["a"]), c("a")]);
    expect(lanesOf(g, ["a", "b", "c"])).toEqual([0, 0, 0]);
    expect(g.laneCount).toBe(1);
    expect(g.edges.map((e) => [e.r1, e.l1, e.r2, e.l2])).toEqual([
      [0, 0, 1, 0],
      [1, 0, 2, 0],
    ]);
  });

  it("分叉：两个子提交分占两 lane 后汇回父辈", () => {
    // 拓扑序（最新在前）: b、c 是 base 的两个子提交，各占一 lane，边汇回 base
    const g = computeGraph([c("b", ["base"]), c("c", ["base"]), c("base")]);
    expect(lanesOf(g, ["b", "c", "base"])).toEqual([0, 1, 0]);
    expect(g.laneCount).toBe(2);
    // b（row0，lane0）的边续在 lane0；c（row1，lane1）的边弯回 lane0
    expect(g.edges.find((e) => e.r1 === 0)).toMatchObject({ r2: 2, l2: 0 });
    expect(g.edges.find((e) => e.r1 === 1)).toMatchObject({ r2: 2, l2: 0 });
  });

  it("合并：first parent 原地接棒，其余 parent 另开 lane", () => {
    // 拓扑序（children 先）: merge → main 侧 → feat2 → feat1 → base
    const g = computeGraph([
      c("merge", ["mainSide", "feat2"]),
      c("mainSide", ["base"]),
      c("feat2", ["feat1"]),
      c("feat1", ["base"]),
      c("base"),
    ]);
    expect(lanesOf(g, ["merge", "mainSide"])).toEqual([0, 0]);
    // feat 支线稳定占 lane 1，全程不横移
    expect(lanesOf(g, ["feat2", "feat1"])).toEqual([1, 1]);
    expect(g.nodes.get("base")!.lane).toBe(0);
    expect(g.laneCount).toBe(2);
    expect(g.edges.find((e) => e.r1 === 0 && e.r2 === 2)).toMatchObject({ l1: 0, l2: 1 });
  });

  it("空槽复用：列号终身稳定，后续线不再被挤到新列（旧实现 splice 压缩会一路膨胀）", () => {
    // 真实 codeMUX 案例的形状：m 预留 p 与 tip，z 线又预留 p
    const g = computeGraph([
      c("m", ["p", "tip"]),
      c("z1", ["z2"]),
      c("z2", ["z3"]),
      c("z3", ["p"]),
      c("p", ["base"]),
      c("base"),
      c("u1", ["u2"]),
      c("u2"),
    ]);
    expect(lanesOf(g, ["m", "p", "base", "u1", "u2"])).toEqual([0, 0, 0, 0, 0]);
    // z 线避开被占的 0，稳定占 lane 1
    expect(lanesOf(g, ["z1", "z3"])).toEqual([1, 1]);
    expect(g.laneCount).toBe(2);
  });

  it("父提交不在可见集（被过滤）→ 沿本列画虚线 stub，不新开列", () => {
    const g = computeGraph([c("b", ["a"]), c("c")]); // a 被过滤掉
    expect(g.nodes.get("b")!.lane).toBe(0);
    const e = g.edges.find((x) => x.r1 === 0)!;
    expect(e.pending).toBe(true);
    expect(e.r2).toBe(2); // commits.length（列表底部之下）
    expect(e.l2).toBe(e.l1); // 不新开列
    // 空槽可复用 → c 落回 lane 0
    expect(g.nodes.get("c")!.lane).toBe(0);
    expect(g.laneCount).toBe(1);
  });

  it("lane 泄漏回归：不可见的父提交不得钉住槽位（搜索过滤会把列数炸开）", () => {
    // 主干 s0→s4，每个提交的父提交都被过滤掉（模拟搜索命中稀疏）
    const spine = Array.from({ length: 5 }, (_, i) => c(`s${i}`, i + 1 < 5 ? [`s${i + 1}`] : []));
    const g = computeGraph(spine);
    // 若不可见 parent 占列，这里会退化成每提交一列（5 列）
    expect(g.laneCount).toBe(1);
    expect(lanesOf(g, ["s0", "s1", "s2", "s3", "s4"])).toEqual([0, 0, 0, 0, 0]);
  });

  it("混合：可见与不可见父提交混排时，可见的仍能正常分列", () => {
    const g = computeGraph([
      c("m", ["a", "gone"]), // gone 不可见 → 不占列
      c("a", ["base"]),
      c("base"),
    ]);
    expect(g.nodes.get("m")!.lane).toBe(0);
    expect(g.nodes.get("a")!.lane).toBe(0);
    expect(g.laneCount).toBe(1);
    expect(g.edges.filter((e) => e.pending)).toHaveLength(1);
  });

  it("laneX 随 lane 线性递增", () => {
    expect(laneX(0)).toBeLessThan(laneX(1));
    expect(laneX(2) - laneX(1)).toBe(laneX(1) - laneX(0));
  });

  it("节点半径与描边能塞进列距内（相邻列不粘连）", () => {
    expect(NODE_R + 0.8).toBeLessThan(LANE_STEP);
    // 同时要留出呼吸感：列距明显大于节点外缘，避免密集成一片
    expect(LANE_STEP - (NODE_R + 0.8)).toBeGreaterThanOrEqual(5);
  });

  it("颜色按列号取：同一列同色，不同列不同色", () => {
    const g = computeGraph([c("b", ["base"]), c("c", ["base"]), c("base")]);
    const [b, c2] = [g.nodes.get("b")!, g.nodes.get("c")!];
    expect(b.color).toBe(BRANCH_PALETTE[0]);
    expect(c2.color).toBe(BRANCH_PALETTE[1]);
    expect(g.nodes.get("base")!.color).toBe(b.color); // 同列同色
  });
});

describe("windowCols / graphWidth", () => {
  const ids = (rows: CommitEntry[]) => (r: number) => rows[r]?.id;

  it("窄窗口只按窗口内的列算宽度，不被全局最宽处撑开", () => {
    // 前 3 行都在 lane 0（当前分支），深层才扇出到 lane 4
    const rows = [
      c("a", ["b"]),
      c("b", ["c"]),
      c("c", ["d"]),
      c("d", ["e"]),
      c("e", ["f"]),
      c("f"),
    ];
    const g = computeGraph(rows);
    expect(g.laneCount).toBe(1);

    // 人为造一条深层分叉，让全局 laneCount 变大
    const wide = [
      c("a", ["b"]),
      c("b", ["c"]),
      c("c", ["d"]),
      c("x1", ["x2"]),
      c("x2", ["d"]),
      c("d", ["e"]),
      c("y1", ["y2"]),
      c("y2", ["y3"]),
      c("y3", ["d"]),
      c("e"),
    ];
    const gw = computeGraph(wide);
    expect(gw.laneCount).toBe(2);

    // 窗口 [0,2] 只覆盖 lane 0 → 1 列；窗口含深层分叉 → 2 列
    expect(windowCols(gw, 0, 2, ids(wide))).toBe(1);
    expect(windowCols(gw, 3, 4, ids(wide))).toBe(2);
  });

  it("跨列的边在其跨越的每一行都计入两端列（曲线连续扫过中间 x）", () => {
    const rows = [c("m", ["base", "f"]), c("f", ["base"]), c("base")];
    const g = computeGraph(rows);
    // m 在 lane 0、f 在 lane 1，边 m→f 跨越 row1 → 该行有墨到 lane 1
    expect(windowCols(g, 1, 1, ids(rows))).toBe(2);
  });

  it("graphWidth 有 96px 下限（覆盖到 4 列），之后线性增长", () => {
    expect(graphWidth(1)).toBe(96);
    expect(graphWidth(4)).toBe(96); // (4+1)*18 = 90，被下限托住
    expect(graphWidth(5)).toBe(6 * LANE_STEP);
    expect(graphWidth(20)).toBe(21 * LANE_STEP);
  });
});

describe("edgeCurve", () => {  it("短边：控制点按 0.45|Δy| 内插，不触发上限", () => {
    const g = edgeCurve(20, 0, 20, 20);
    expect(g.move).toEqual([20, 0]);
    expect(g.c1).toEqual([20, 9]);
    expect(g.c2).toEqual([20, 11]);
    expect(g.to).toEqual([20, 20]);
  });

  it("长边：控制点被 BEND_MAX 钳制，首尾之外近乎直线", () => {
    const long = edgeCurve(20, 0, 64, 600);
    expect(long.c1[1]).toBe(BEND_MAX);
    expect(long.c2[1]).toBe(600 - BEND_MAX);
    // 未钳制时控制点会在 270（=600*0.45），正是「鼓成一团」的来源
    expect(600 * 0.45).toBeGreaterThan(BEND_MAX * 7);
  });

  it("临界长度：恰好等于上限时两者一致", () => {
    const dy = BEND_MAX / 0.45;
    const g = edgeCurve(0, 0, 0, dy);
    expect(g.c1[1]).toBeCloseTo(BEND_MAX);
  });

  it("向上绘制（Δy 为负）时控制点方向相应翻转", () => {
    const g = edgeCurve(20, 100, 20, 0);
    expect(g.c1).toEqual([20, 100 - BEND_MAX]);
    expect(g.c2).toEqual([20, BEND_MAX]);
  });

  it("x 坐标原样透传（垂直切线）", () => {
    const g = edgeCurve(11, 0, 77, 40);
    expect(g.c1[0]).toBe(11);
    expect(g.c2[0]).toBe(77);
  });
});
