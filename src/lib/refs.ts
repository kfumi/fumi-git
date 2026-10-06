// ref 分类（HEAD / 远程 / 标签 / 本地分支）—— RefChips 与 Sidebar 共用，避免散点分支
export type RefKind = "head" | "remote" | "tag" | "branch";

export function classifyRef(ref: string): RefKind {
  if (ref === "HEAD") return "head";
  if (ref.startsWith("origin/")) return "remote";
  if (ref.startsWith("tag:")) return "tag";
  return "branch";
}
