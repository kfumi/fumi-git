// 左侧栏：仓库列表 / 分支（来自图谱 ref 装饰）/ 远程
import { useMemo } from "react";
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
    <aside className="min-h-0 overflow-y-auto border-r border-brd bg-panel px-2 py-2.5">
      <h4 className="px-2 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
        仓库
      </h4>
      {(config?.recent_repos ?? []).map((e) => (
        <div key={e.path} className="group flex items-center">
          <button
            onClick={() => void openRepo(e.path)}
            className={
              "flex-1 truncate rounded-md px-2 py-[5px] text-left text-xs " +
              (meta?.path === e.path ? "bg-accent-soft text-accent-ink" : "text-dim hover:bg-hover hover:text-ink")
            }
            title={e.path}
          >
            {meta?.path === e.path ? "▸ " : "  "}
            {e.name}
          </button>
          <button
            title="从列表移除"
            onClick={() => void removeRecent(e.path)}
            className="mr-1 hidden text-faint hover:text-bad group-hover:block"
          >
            ✕
          </button>
        </div>
      ))}

      <h4 className="px-2 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
        分支
      </h4>
      {[...branches.entries()].map(([name, id]) => (
        <button
          key={name}
          onClick={() => void select(id)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-xs text-dim hover:bg-hover hover:text-ink"
        >
          <span className="truncate">
            ⑂ {name}
            {summary?.branch === name && summary.upstream && (summary.ahead > 0 || summary.behind > 0) && (
              <span className="ml-1 text-[10px]">
                {summary.ahead > 0 && <span className="text-ok">↑{summary.ahead}</span>}
                {summary.behind > 0 && <span className="text-warn">↓{summary.behind}</span>}
              </span>
            )}
          </span>
        </button>
      ))}

      {tags.size > 0 && (
        <>
          <h4 className="px-2 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
            标签
          </h4>
          {[...tags.entries()].slice(0, 20).map(([name, id]) => (
            <button
              key={name}
              onClick={() => void select(id)}
              className="block w-full truncate rounded-md px-2 py-[5px] text-left text-xs text-dim hover:bg-hover hover:text-ink"
            >
              ⚑ {name.slice(4)}
            </button>
          ))}
        </>
      )}

      {remotes.size > 0 && (
        <>
          <h4 className="px-2 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
            远程
          </h4>
          {[...remotes.entries()].slice(0, 20).map(([name, id]) => (
            <button
              key={name}
              onClick={() => void select(id)}
              className="block w-full truncate rounded-md px-2 py-[5px] text-left text-xs text-dim hover:bg-hover hover:text-ink"
            >
              ⇅ {name}
            </button>
          ))}
        </>
      )}
    </aside>
  );
}
