import { describe, expect, it } from "vitest";
import { classifyRef, groupBranches } from "./refs";

describe("classifyRef", () => {
  it("HEAD / 标签 / 本地分支各归各类", () => {
    expect(classifyRef("HEAD")).toBe("head");
    expect(classifyRef("tag:v1.0", ["origin"])).toBe("tag");
    expect(classifyRef("feat/login", ["origin"])).toBe("branch");
  });

  it("多远程：各远程前缀都判为远程 ref", () => {
    const remotes = ["origin", "gitee"];
    expect(classifyRef("origin/main", remotes)).toBe("remote");
    expect(classifyRef("gitee/main", remotes)).toBe("remote");
    // 同名本地分支不受远程列表影响
    expect(classifyRef("gitee", remotes)).toBe("branch");
    // 未列出的前缀仍按本地分支处理
    expect(classifyRef("upstream/main", remotes)).toBe("branch");
  });

  it("缺省沿用 origin 兜底（远程列表未就绪时）", () => {
    expect(classifyRef("origin/main")).toBe("remote");
    expect(classifyRef("gitee/main")).toBe("branch");
  });
});

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
