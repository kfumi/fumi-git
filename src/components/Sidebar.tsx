// 左侧栏：仓库列表 / 分支（来自图谱 ref 装饰）/ 远程
import { useMemo } from "react";
import { ChevronRight, Cloud, GitBranch, Tag, X } from "lucide-react";
import { useRepo } from "../stores/repo";
import { classifyRef } from "../lib/refs";

export function Sidebar() {
  const config = useRepo((s) => s.config);
  const meta = useRepo((s) => s.meta);
  const commits = useRepo((s) => s.commits);
  const openRepo = useRepo((s) => s.openRepo);
  const removeRecent = useRepo((s) => s.removeRecent);
  const select = useRepo((s) => s.select);
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
                "flex flex-1 items-center gap-1.5 truncate rounded-md px-2 py-[5px] text-left text-xs transition-colors " +
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
      {[...branches.entries()].map(([name, id]) => (
        <button
          key={name}
          onClick={() => void select(id)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
        >
          <GitBranch size={11} aria-hidden className="shrink-0 text-faint" />
          <span className="truncate">
            {name}
            {summary?.branch === name &&
              summary.upstream &&
              (summary.ahead > 0 || summary.behind > 0) && (
                <span className="tnum ml-1 text-[10px]">
                  {summary.ahead > 0 && <span className="text-ok">↑{summary.ahead}</span>}
                  {summary.behind > 0 && <span className="text-warn">↓{summary.behind}</span>}
                </span>
              )}
          </span>
        </button>
      ))}

      {tags.size > 0 && (
        <>
          <h4 className="section-label pb-1.5 pt-4">标签</h4>
          {[...tags.entries()].slice(0, 20).map(([name, id]) => (
            <button
              key={name}
              onClick={() => void select(id)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
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
              onClick={() => void select(id)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
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
