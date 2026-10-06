// ref 分类（HEAD / 远程 / 标签 / 本地分支）—— RefChips 与 Sidebar 共用，避免散点分支
export type RefKind = "head" | "remote" | "tag" | "branch";

export function classifyRef(ref: string): RefKind {
  if (ref === "HEAD") return "head";
  if (ref.startsWith("origin/")) return "remote";
  if (ref.startsWith("tag:")) return "tag";
  return "branch";
}

export interface BranchGrouping {
  /** 无 "/" 的根分支：[分支名, tip 提交] */
  roots: [string, string][];
  /** 按首个 "/" 前缀分组：[前缀, [组内剩余名, tip][]]，前后缀均按名称排序 */
  groups: [string, [string, string][]][];
}

/** 分支按首个 "/" 前缀分组（VS Code 源代码管理风格），组内外均按名称排序 */
export function groupBranches(branches: Iterable<[string, string]>): BranchGrouping {
  const roots: [string, string][] = [];
  const map = new Map<string, [string, string][]>();
  for (const [name, tip] of branches) {
    const i = name.indexOf("/");
    if (i === -1) {
      roots.push([name, tip]);
    } else {
      const prefix = name.slice(0, i);
      const list = map.get(prefix) ?? [];
      list.push([name.slice(i + 1), tip]);
      map.set(prefix, list);
    }
  }
  const byName = (a: [string, string], b: [string, string]) => a[0].localeCompare(b[0]);
  roots.sort(byName);
  const groups = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, members] of groups) members.sort(byName);
  return { roots, groups };
}
