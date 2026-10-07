// ref 分类（HEAD / 远程 / 标签 / 本地分支）—— RefChips 与 Sidebar 共用，避免散点分支
export type RefKind = "head" | "remote" | "tag" | "branch";

/** 默认远程名：未加载到真实远程列表时的兜底（保持单远程仓库的历史行为） */
const FALLBACK_REMOTES = ["origin"];

/**
 * ref 分类。多远程仓库下 `gitee/main` 与 `origin/main` 同为远程 ref，
 * 因此远程名前缀取自真实远程列表（store 的 remotes），不写死 origin。
 */
export function classifyRef(ref: string, remotes: Iterable<string> = FALLBACK_REMOTES): RefKind {
  if (ref === "HEAD") return "head";
  if (ref.startsWith("tag:")) return "tag";
  for (const remote of remotes) {
    if (remote && ref.startsWith(`${remote}/`)) return "remote";
  }
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

/**
 * 拆分远程 ref 为 [远端名, 分支部分]。
 * 优先按真实远程列表做最长前缀匹配（兼容远端名本身含 "/" 的极端情况），
 * 匹配不上时退化为按首个 "/" 切分，保证未知远端也不丢展示。
 */
export function splitRemoteRef(
  fullRef: string,
  remotes: Iterable<string> = FALLBACK_REMOTES,
): [string, string] {
  const list = [...remotes].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const r of list) {
    if (fullRef === r) return [r, ""];
    if (fullRef.startsWith(`${r}/`)) return [r, fullRef.slice(r.length + 1)];
  }
  const i = fullRef.indexOf("/");
  if (i === -1) return [fullRef, ""];
  return [fullRef.slice(0, i), fullRef.slice(i + 1)];
}

/**
 * 远程 refs 按远端名分组，第二层复用 groupBranches 做 "/" 分层
 * （VS Code 源代码管理风格，与本地分支一致）。
 * 返回按远端名排序的 [远端名, BranchGrouping][]，
 * 其中 BranchGrouping 内名称均为去掉 "<远端>/" 后的分支部分，
 * 完整 ref 可由 `<远端>/<分支部分>` 拼回。
 */
export function groupRemotes(
  refs: Iterable<[string, string]>,
  remotes: Iterable<string> = FALLBACK_REMOTES,
): [string, BranchGrouping][] {
  const buckets = new Map<string, [string, string][]>();
  for (const [full, tip] of refs) {
    const [remote, rest] = splitRemoteRef(full, remotes);
    const list = buckets.get(remote) ?? [];
    list.push([rest, tip]);
    buckets.set(remote, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([remote, branches]): [string, BranchGrouping] => [remote, groupBranches(branches)]);
}
