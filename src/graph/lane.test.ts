import { describe, expect, it } from "vitest";
import { computeGraph, laneX } from "./lane";
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

describe("computeGraph", () => {
  it("线性历史：全部占 lane 0", () => {
    const g = computeGraph([c("c", ["b"]), c("b", ["a"]), c("a")]);
    expect(g.laneCount).toBe(1);
    expect(g.nodes.get("a")!.lane).toBe(0);
    expect(g.nodes.get("b")!.lane).toBe(0);
    expect(g.nodes.get("c")!.lane).toBe(0);
    expect(g.edges.map((e) => [e.r1, e.l1, e.r2, e.l2])).toEqual([
      [0, 0, 1, 0],
      [1, 0, 2, 0],
    ]);
  });

  it("分叉：两个子提交分占两 lane 后汇回父辈", () => {
    // 拓扑序（最新在前）: b、c 是 base 的两个子提交，各占一 lane，边汇回 base
    const g = computeGraph([c("b", ["base"]), c("c", ["base"]), c("base")]);
    expect(g.nodes.get("b")!.lane).toBe(0);
    expect(g.nodes.get("c")!.lane).toBe(1);
    expect(g.nodes.get("base")!.lane).toBe(0);
    expect(g.laneCount).toBe(2);
    // b（row0）延续 lane0 指向 base；c（row1，lane1）的边弯回 base 所在 lane0
    const eB = g.edges.find((e) => e.r1 === 0)!;
    const eC = g.edges.find((e) => e.r1 === 1)!;
    expect(eB.r2).toBe(2);
    expect(eB.l2).toBe(0);
    expect(eC.r2).toBe(2);
    expect(eC.l2).toBe(0);
  });

  it("合并：feature lane 汇回主干后回收", () => {
    // 拓扑序（children 先）: merge → main 侧 → feat2 → feat1 → base
    const g = computeGraph([
      c("merge", ["mainSide", "feat2"]),
      c("mainSide", ["base"]),
      c("feat2", ["feat1"]),
      c("feat1", ["base"]),
      c("base"),
    ]);
    // merge 在 lane0；mainSide 延续 lane0；feat2 开 lane1；feat1 延续 lane1；
    // feat1 的父 base 已在 lane0 → feat lane 释放；base 在 lane0
    expect(g.nodes.get("merge")!.lane).toBe(0);
    expect(g.nodes.get("mainSide")!.lane).toBe(0);
    expect(g.nodes.get("feat2")!.lane).toBe(1);
    expect(g.nodes.get("feat1")!.lane).toBe(1);
    expect(g.nodes.get("base")!.lane).toBe(0);
    expect(g.laneCount).toBe(2);
    // 合并边从 merge 弯到 feat2 所在 lane1
    const mergeToF2 = g.edges.find((e) => e.r1 === 0 && e.r2 === 2)!;
    expect(mergeToF2.l2).toBe(1);
  });

  it("父提交不在可见集（被过滤）时：边省略、lane 回收", () => {
    const g = computeGraph([c("b", ["a"]), c("c")]); // a 被过滤掉
    const nodeB = g.nodes.get("b")!;
    expect(nodeB.lane).toBe(0);
    expect(g.edges.filter((e) => e.r1 === 0).length).toBe(0);
    // c 与 b 各自独立 lane
    expect(g.nodes.get("c")!.lane).toBe(0); // b 的 lane 因父缺失立即回收，c 复用 lane0
    expect(g.laneCount).toBe(1);
  });

  it("laneX 随 lane 线性递增", () => {
    expect(laneX(0)).toBeLessThan(laneX(1));
    expect(laneX(2) - laneX(1)).toBe(laneX(1) - laneX(0));
  });

  it("调色板循环取色", () => {
    const commits = [c("r0"), c("r1"), c("r2"), c("r3")];
    const g = computeGraph(commits);
    const colors = new Set([...g.nodes.values()].map((n) => n.color));
    expect(colors.size).toBe(4); // 四个独立根各取一色
  });
});
