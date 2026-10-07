// 左侧栏：仓库列表 / 分支（来自图谱 ref 装饰，按 "/" 前缀分组折叠）/ 远程（按远端名 + "/" 分层，与分支同风格）
import { useMemo, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  GitBranch,
  Plus,
  Tag,
  X,
} from "lucide-react";
import { useRepo } from "../stores/repo";
import { classifyRef, groupBranches, groupRemotes } from "../lib/refs";
import { relTime } from "../lib/format";
import type { BranchSummary, StashEntry } from "../lib/types";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const GROUPS_KEY = "fumigit.expanded-branch-groups";
const REMOTE_GROUPS_KEY = "fumigit.expanded-remote-groups";
const REMOTE_SUBGROUPS_KEY = "fumigit.expanded-remote-subgroups";

function loadExpandedGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
    return Array.isArray(raw) ? new Set(raw.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function loadStringSet(key: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? new Set(raw.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function persistStringSet(key: string, next: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...next]));
  } catch {
    // 持久化失败只影响下次启动的展开状态
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
  const remoteNames = useRepo((s) => s.remotes);
  const checkout = useRepo((s) => s.checkout);
  const createBranchFlow = useRepo((s) => s.createBranchFlow);
  const deleteBranchFlow = useRepo((s) => s.deleteBranchFlow);
  const renameBranchFlow = useRepo((s) => s.renameBranchFlow);
  const mergeBranchFlow = useRepo((s) => s.mergeBranchFlow);
  const stashes = useRepo((s) => s.stashes);
  const stashView = useRepo((s) => s.stashView);
  const selectStash = useRepo((s) => s.selectStash);
  const stashFlow = useRepo((s) => s.stashFlow);
  const stashRestore = useRepo((s) => s.stashRestore);
  const stashDropFlow = useRepo((s) => s.stashDropFlow);
  // 分支右键菜单：{ 位置, 分支全名 }
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; branch: string } | null>(
    null,
  );
  // stash 条目右键菜单：{ 位置, 条目 }
  const [stashMenu, setStashMenu] = useState<{ x: number; y: number; entry: StashEntry } | null>(
    null,
  );

  const stashMenuItems = (entry: StashEntry): MenuItem[] => [
    { label: "恢复并从列表移除", hint: "stash pop", onSelect: () => void stashRestore(entry.index, true) },
    { label: "恢复并保留副本", hint: "stash apply", onSelect: () => void stashRestore(entry.index, false) },
    { kind: "separator" },
    { label: "删除…", danger: true, onSelect: () => stashDropFlow(entry.index) },
  ];

// 三组动作：把当前分支指到该分支 / 该分支自身的增删改名 / 破坏性
  const branchMenuItems = (branch: string): MenuItem[] => {
    const current = summary?.branch === branch;
    const moveItems: MenuItem[] = [
      {
        label: "迁出到该分支",
        disabled: current,
        hint: current ? "当前分支" : undefined,
        onSelect: () => void checkout(branch),
      },
      {
        label: "合并到当前分支…",
        disabled: current,
        hint: current ? "当前分支" : undefined,
        onSelect: () => void mergeBranchFlow(branch),
      },
    ];
    const manageItems: MenuItem[] = [
      { label: "新建分支…", hint: "基于当前 HEAD", onSelect: () => createBranchFlow() },
      { label: "重命名…", onSelect: () => renameBranchFlow(branch) },
    ];
    const destructiveItems: MenuItem[] = [
      {
        label: "删除该分支…",
        disabled: current,
        hint: current ? "当前分支" : undefined,
        danger: true,
        onSelect: () => deleteBranchFlow(branch),
      },
    ];
    return [
      ...moveItems,
      { kind: "separator" },
      ...manageItems,
      { kind: "separator" },
      ...destructiveItems,
    ];
  };

  const { branches, remoteRefs, tags } = useMemo(() => {
    const b = new Map<string, string>(); // name -> tip commit id
    const r = new Map<string, string>();
    const t = new Map<string, string>();
    for (const c of commits) {
      for (const ref of c.refs) {
        switch (classifyRef(ref, remoteNames)) {
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
    return { branches: b, remoteRefs: r, tags: t };
  }, [commits, remoteNames]);

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

  // 远程先按远端名分组，第二层复用分支式 "/" 分层；两层折叠状态各自持久化
  const remoteTree = useMemo(
    () => groupRemotes(remoteRefs.entries(), remoteNames),
    [remoteRefs, remoteNames],
  );
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(() =>
    loadStringSet(REMOTE_GROUPS_KEY),
  );
  const [expandedRemoteSubs, setExpandedRemoteSubs] = useState<Set<string>>(() =>
    loadStringSet(REMOTE_SUBGROUPS_KEY),
  );
  const toggleRemote = (remote: string) =>
    setExpandedRemotes((prev) => {
      const next = new Set(prev);
      if (next.has(remote)) next.delete(remote);
      else next.add(remote);
      persistStringSet(REMOTE_GROUPS_KEY, next);
      return next;
    });
  const toggleRemoteSub = (key: string) =>
    setExpandedRemoteSubs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistStringSet(REMOTE_SUBGROUPS_KEY, next);
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
              aria-label={'从列表移除 ' + e.name}
              onClick={() => void removeRecent(e.path)}
              className="mr-1 hidden rounded p-0.5 text-faint transition-colors hover:text-bad group-hover:block"
            >
              <X size={11} aria-hidden />
            </button>
          </div>
        );
      })}

      <div className="flex items-center justify-between pr-1">
        <h4 className="section-label pb-1.5 pt-4">分支</h4>
        <button
          title="新建分支"
          aria-label="新建分支"
          onClick={() => createBranchFlow()}
          className="mb-1 rounded p-1 text-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <Plus size={12} aria-hidden />
        </button>
      </div>
      {tree.roots.map(([name, id]) => (
        <BranchRow
          key={name}
          name={name}
          fullName={name}
          tip={id}
          current={summary?.branch === name}
          summary={summary}
          onSelect={() => selectRefTip(id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setBranchMenu({ x: e.clientX, y: e.clientY, branch: name });
          }}
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setBranchMenu({
                      x: e.clientX,
                      y: e.clientY,
                      branch: prefix + "/" + rest,
                    });
                  }}
                />
              ))}
          </div>
        );
      })}

      {branchMenu && (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          items={branchMenuItems(branchMenu.branch)}
          onClose={() => setBranchMenu(null)}
        />
      )}

      <div className="flex items-center justify-between pr-1">
        <h4 className="section-label pb-1.5 pt-4">stash</h4>
        <button
          title="暂存全部改动到 stash"
          aria-label="暂存到 stash"
          onClick={() => stashFlow()}
          className="mb-1 rounded p-1 text-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <Plus size={12} aria-hidden />
        </button>
      </div>
      {stashes.length === 0 && (
        <p className="px-2 pb-1 text-[11px] text-faint">暂无存档</p>
      )}
      {stashes.map((e) => (
        <button
          key={e.index}
          onClick={() => void selectStash(e.index)}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setStashMenu({ x: ev.clientX, y: ev.clientY, entry: e });
          }}
          title={e.message}
          className={
            "flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-xs transition-colors " +
            (stashView?.index === e.index
              ? "bg-sel text-ink"
              : "text-dim hover:bg-hover hover:text-ink")
          }
        >
          <Archive size={11} aria-hidden className="shrink-0 text-faint" />
          <span className="truncate">{e.message}</span>
          <span className="tnum ml-auto shrink-0 text-[10px] text-faint">
            {relTime(e.time)}
          </span>
        </button>
      ))}
      {stashMenu && (
        <ContextMenu
          x={stashMenu.x}
          y={stashMenu.y}
          items={stashMenuItems(stashMenu.entry)}
          onClose={() => setStashMenu(null)}
        />
      )}

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

      {remoteTree.length > 0 && (
        <>
          <h4 className="section-label pb-1.5 pt-4">远程</h4>
          {remoteTree.map(([remote, grouping]) => {
            const open = expandedRemotes.has(remote);
            const total =
              grouping.roots.length +
              grouping.groups.reduce((n, [, members]) => n + members.length, 0);
            return (
              <div key={remote}>
                <button
                  onClick={() => toggleRemote(remote)}
                  aria-expanded={open}
                  title={remote}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
                >
                  {open ? (
                    <ChevronDown size={11} aria-hidden className="shrink-0 text-faint" />
                  ) : (
                    <ChevronRight size={11} aria-hidden className="shrink-0 text-faint" />
                  )}
                  <Cloud size={11} aria-hidden className="shrink-0 text-faint" />
                  <span className="truncate">{remote}</span>
                  <span className="tnum ml-auto text-[10px] text-faint">{total}</span>
                </button>
                {open &&
                  grouping.roots.map(([name, id]) => {
                    const full = name ? remote + "/" + name : remote;
                    const label = name === "" ? "(空)" : name;
                    return (
                      <button
                        key={full}
                        onClick={() => selectRefTip(id)}
                        title={full + " → " + id.slice(0, 7)}
                        className="flex w-full items-center gap-1.5 rounded-md py-[7px] pl-7 pr-2 text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
                      >
                        <Cloud size={11} aria-hidden className="shrink-0 text-faint" />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                {open &&
                  grouping.groups.map(([prefix, members]) => {
                    const subKey = remote + "/" + prefix;
                    const subOpen = expandedRemoteSubs.has(subKey);
                    return (
                      <div key={subKey}>
                        <button
                          onClick={() => toggleRemoteSub(subKey)}
                          aria-expanded={subOpen}
                          title={subKey}
                          className="flex w-full items-center gap-1.5 rounded-md py-[7px] pl-7 pr-2 text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
                        >
                          {subOpen ? (
                            <ChevronDown size={11} aria-hidden className="shrink-0 text-faint" />
                          ) : (
                            <ChevronRight size={11} aria-hidden className="shrink-0 text-faint" />
                          )}
                          {subOpen ? (
                            <FolderOpen size={11} aria-hidden className="shrink-0 text-faint" />
                          ) : (
                            <Folder size={11} aria-hidden className="shrink-0 text-faint" />
                          )}
                          <span className="truncate">{prefix}</span>
                          <span className="tnum ml-auto text-[10px] text-faint">
                            {members.length}
                          </span>
                        </button>
                        {subOpen &&
                          members.map(([rest, id]) => {
                            const full = remote + "/" + prefix + "/" + rest;
                            return (
                              <button
                                key={full}
                                onClick={() => selectRefTip(id)}
                                title={full + " → " + id.slice(0, 7)}
                                className="flex w-full items-center gap-1.5 rounded-md py-[7px] pl-10 pr-2 text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
                              >
                                <Cloud size={11} aria-hidden className="shrink-0 text-faint" />
                                <span className="truncate">{rest}</span>
                              </button>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}
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
  onContextMenu,
}: {
  name: string;
  fullName: string;
  tip: string;
  indent?: boolean;
  current: boolean;
  summary: BranchSummary | null;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={fullName + " → " + tip.slice(0, 7)}
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

