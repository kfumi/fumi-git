// 左侧栏：仓库列表 / 分支（来自图谱 ref 装饰，按 "/" 前缀分组折叠）/ 远程
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  GitBranch,
  Tag,
  X,
} from "lucide-react";
import { useRepo } from "../stores/repo";
import { classifyRef, groupBranches } from "../lib/refs";
import type { BranchSummary } from "../lib/types";

const GROUPS_KEY = "fumigit.expanded-branch-groups";

function loadExpandedGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
    return Array.isArray(raw) ? new Set(raw.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function Sidebar() {
  const config = useRepo((s) => s.config);
  const meta = useRepo((s) => s.meta);
  const commits = useRepo((s) => s.commits);
  const openRepo = useRepo((s) => s.openRepo);
  const removeRecent = useRepo((s) => s.removeRecent);
  const selectRefTip = useRepo((s) => s.selectRefTip);
  const summary = useRepo((s) => s.summary);

  const { branches, remotes, tags } = useMemo(() => {
    const b = new Map<string, string>(); // name -> tip commit id
    const r = new Map<string, string>();
    const t = new Map<string, string>();
    for (const c of commits) {
      for (const ref of c.refs) {
        switch (classifyRef(ref)) {
          case "head":
            break;
          case "remote":
            r.set(ref, c.id);
            break;
          case "tag":
            t.set(ref, c.id);
            break;
          default:
            b.set(ref, c.id);
        }
      }
    }
    return { branches: b, remotes: r, tags: t };
  }, [commits]);

  // 分支按 "/" 前缀分组；折叠状态持久化到 localStorage
  const tree = useMemo(() => groupBranches(branches), [branches]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(loadExpandedGroups);
  const toggleGroup = (prefix: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // 持久化失败只影响下次启动的展开状态
      }
      return next;
    });

  return (
    <aside className="h-full min-h-0 overflow-y-auto bg-panel px-2 py-3">
      <h4 className="section-label pb-1.5 pt-1">仓库</h4>
      {(config?.recent_repos ?? []).map((e) => {
        const active = meta?.path === e.path;
        return (
          <div key={e.path} className="group flex items-center">
            <button
              onClick={() => void openRepo(e.path)}
              className={
                "flex flex-1 items-center gap-1.5 truncate rounded-md px-2 py-[7px] text-left text-xs transition-colors " +
                (active
                  ? "bg-accent-soft font-medium text-accent-ink"
                  : "text-dim hover:bg-hover hover:text-ink")
              }
              title={e.path}
            >
              <ChevronRight
                size={11}
                aria-hidden
                className={"shrink-0 " + (active ? "" : "opacity-0")}
              />
              <span className="truncate">{e.name}</span>
            </button>
            <button
              title="从列表移除"
              aria-label={`从列表移除 ${e.name}`}
              onClick={() => void removeRecent(e.path)}
              className="mr-1 hidden rounded p-0.5 text-faint transition-colors hover:text-bad group-hover:block"
            >
              <X size={11} aria-hidden />
            </button>
          </div>
        );
      })}

      <h4 className="section-label pb-1.5 pt-4">分支</h4>
      {tree.roots.map(([name, id]) => (
        <BranchRow
          key={name}
          name={name}
          fullName={name}
          tip={id}
          current={summary?.branch === name}
          summary={summary}
          onSelect={() => selectRefTip(id)}
        />
      ))}
      {tree.groups.map(([prefix, members]) => {
        const open = expandedGroups.has(prefix);
        return (
          <div key={prefix}>
            <button
              onClick={() => toggleGroup(prefix)}
              aria-expanded={open}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
            >
              {open ? (
                <ChevronDown size={11} aria-hidden className="shrink-0 text-faint" />
              ) : (
                <ChevronRight size={11} aria-hidden className="shrink-0 text-faint" />
              )}
              {open ? (
                <FolderOpen size={11} aria-hidden className="shrink-0 text-faint" />
              ) : (
                <Folder size={11} aria-hidden className="shrink-0 text-faint" />
              )}
              <span className="truncate">{prefix}</span>
              <span className="tnum ml-auto text-[10px] text-faint">{members.length}</span>
            </button>
            {open &&
              members.map(([rest, id]) => (
                <BranchRow
                  key={prefix + "/" + rest}
                  name={rest}
                  fullName={prefix + "/" + rest}
                  tip={id}
                  indent
                  current={summary?.branch === prefix + "/" + rest}
                  summary={summary}
                  onSelect={() => selectRefTip(id)}
                />
              ))}
          </div>
        );
      })}

      {tags.size > 0 && (
        <>
          <h4 className="section-label pb-1.5 pt-4">标签</h4>
          {[...tags.entries()].slice(0, 20).map(([name, id]) => (
            <button
              key={name}
              onClick={() => selectRefTip(id)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <Tag size={11} aria-hidden className="shrink-0 text-warn/80" />
              <span className="truncate">{name.slice(4)}</span>
            </button>
          ))}
        </>
      )}

      {remotes.size > 0 && (
        <>
          <h4 className="section-label pb-1.5 pt-4">远程</h4>
          {[...remotes.entries()].slice(0, 20).map(([name, id]) => (
            <button
              key={name}
              onClick={() => selectRefTip(id)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <Cloud size={11} aria-hidden className="shrink-0 text-faint" />
              <span className="truncate">{name}</span>
            </button>
          ))}
        </>
      )}
    </aside>
  );
}

function BranchRow({
  name,
  fullName,
  tip,
  indent,
  current,
  summary,
  onSelect,
}: {
  name: string;
  fullName: string;
  tip: string;
  indent?: boolean;
  current: boolean;
  summary: BranchSummary | null;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      title={`${fullName} → ${tip.slice(0, 7)}`}
      className={
        "flex w-full items-center gap-1.5 rounded-md py-[7px] pr-2 text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink " +
        (indent ? "pl-7" : "pl-2")
      }
    >
      <GitBranch size={11} aria-hidden className="shrink-0 text-faint" />
      <span className="truncate">
        {name}
        {current && summary?.upstream && (summary.ahead > 0 || summary.behind > 0) && (
          <span className="tnum ml-1 text-[10px]">
            {summary.ahead > 0 && <span className="text-ok">↑{summary.ahead}</span>}
            {summary.behind > 0 && <span className="text-warn">↓{summary.behind}</span>}
          </span>
        )}
      </span>
    </button>
  );
}
