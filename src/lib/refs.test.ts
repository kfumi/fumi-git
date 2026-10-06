import { describe, expect, it } from "vitest";
import { groupBranches } from "./refs";

describe("groupBranches", () => {
  it("无 / 的根分支留在 roots；同前缀分组并排序", () => {
    const g = groupBranches([
      ["fix/b", "3"],
      ["master", "1"],
      ["feat/a", "2"],
      ["fix/a", "4"],
    ]);
    expect(g.roots).toEqual([["master", "1"]]);
    expect(g.groups).toEqual([
      ["feat", [["a", "2"]]],
      ["fix", [["a", "4"], ["b", "3"]]],
    ]);
  });

  it("多级前缀只按第一级分组，剩余名整体保留", () => {
    const g = groupBranches([
      ["gitee/feat/x", "1"],
      ["gitee/fix/y", "2"],
      ["main", "3"],
    ]);
    expect(g.groups).toEqual([
      ["gitee", [["feat/x", "1"], ["fix/y", "2"]]],
    ]);
    expect(g.roots).toEqual([["main", "3"]]);
  });

  it("空输入返回空结构", () => {
    expect(groupBranches([])).toEqual({ roots: [], groups: [] });
  });
});
