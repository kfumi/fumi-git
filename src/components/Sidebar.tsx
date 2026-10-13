// 左侧栏：仓库列表 / 分支 / 标签 / 远程。
// 引用数据来自 store.refs（后端 for-each-ref 全量列表），不从图谱提交推导——
// 提交上的 ref 装饰只存在于已加载的分页内，tip 落在窗口外的分支/标签会整个丢失。
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
import { groupBranches, groupRemotes } from "../lib/refs";
import { relTime } from "../lib/format";
import type { BranchSummary, StashEntry } from "../lib/types";
import {
  branchMenu as buildBranchMenu,
  remoteMenu as buildRemoteMenu,
  detachedHead,
  type BranchMenuActions,
  type BranchTarget,
  type RemoteMenuActions,
  type RemoteTarget,
} from "../lib/menus";
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
  const refs = useRepo((s) => s.refs);
  const openRepo = useRepo((s) => s.openRepo);
  const removeRecent = useRepo((s) => s.removeRecent);
  const selectRefTip = useRepo((s) => s.selectRefTip);
  const summary = useRepo((s) => s.summary);
  // 分离 HEAD（无当前分支）：状态行 + 写操作禁用矩阵（ui-spec §4）
  const det = detachedHead(summary);
  const detached = det !== null;
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
  const copyText = useRepo((s) => s.copyText);
  const commits = useRepo((s) => s.commits);
  const checkoutRemote = useRepo((s) => s.checkoutRemote);
  const pushToRemote = useRepo((s) => s.pushToRemote);
  const fetchRemoteFlow = useRepo((s) => s.fetchRemoteFlow);
  const deleteRemoteBranchFlow = useRepo((s) => s.deleteRemoteBranchFlow);
  const setUpstreamFlow = useRepo((s) => s.setUpstreamFlow);
  const unsetUpstream = useRepo((s) => s.unsetUpstream);
  const pushBranchFlow = useRepo((s) => s.pushBranchFlow);
  const fetchForBranch = useRepo((s) => s.fetchForBranch);
  const rebaseOntoFlow = useRepo((s) => s.rebaseOntoFlow);
  // 分支右键菜单：{ 位置, 目标 }；菜单项由 lib/menus.ts 单点构造（ui-spec §4）
  const [branchMenu, setBranchMenu] = useState<{
    x: number;
    y: number;
    target: BranchTarget;
  } | null>(null);
  // 远程分支右键菜单：{ 位置, 目标 }
  const [remoteMenu, setRemoteMenu] = useState<{
    x: number;
    y: number;
    target: RemoteTarget;
  } | null>(null);
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

  // 动作包：菜单项由 lib/menus.ts 单点构造（ui-spec §4）；本地分支与远程分支共用一份
  const menuActions: BranchMenuActions & RemoteMenuActions = {
    checkout: (b) => void checkout(b),
    mergeBranch: (ref) => void mergeBranchFlow(ref),
    createBranchFrom: (ref, label) => createBranchFlow({ ref, label }),
    copy: (text, label) => void copyText(text, label),
    renameBranch: (b) => renameBranchFlow(b),
    deleteBranch: (b) => void deleteBranchFlow(b),
    rebaseOnto: (ref) => void rebaseOntoFlow(ref),
    setUpstream: (b) => setUpstreamFlow(b),
    unsetUpstream: (b) => void unsetUpstream(b),
    pushBranch: (b) => void pushBranchFlow(b),
    fetchForBranch: (b) => void fetchForBranch(b),
    checkoutRemote: (full, branch) => void checkoutRemote(full, branch),
    pushToRemote: (remote, branch) => void pushToRemote(remote, branch),
    fetch: (remote) => void fetchRemoteFlow(remote),
    deleteRemoteBranch: (remote, branch) => void deleteRemoteBranchFlow(remote, branch),
  };

  const openBranchMenu = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    setBranchMenu({
      x: e.clientX,
      y: e.clientY,
      target: {
        name,
        current: summary?.branch === name,
        upstream: upstreams.get(name) ?? null,
        detached,
      },
    });
  };

  const openRemoteMenu = (e: React.MouseEvent, remote: string, branch: string, full: string) => {
    e.preventDefault();
    setRemoteMenu({
      x: e.clientX,
      y: e.clientY,
      target: { remote, branch, full, hasLocal: branches.has(branch), detached },
    });
  };

  // 按后端给的 kind 直接分流；同名 ref（origin/main 与 main）各归各类，互不覆盖
  const { branches, remoteRefs, upstreams } = useMemo(() => {
    const b = new Map<string, string>(); // name -> tip commit id
    const r = new Map<string, string>();
    const u = new Map<string, string | null>(); // name -> 上游短名（04）
    for (const e of refs) {
      if (e.kind === "branch") {
        b.set(e.name, e.tip);
        u.set(e.name, e.upstream ?? null);
      } else if (e.kind === "remote") r.set(e.name, e.tip);
    }
    return { branches: b, remoteRefs: r, upstreams: u };
  }, [refs]);

  // 标签按创建时间倒序（新→旧）；同名不可能，但同刻创建的按名称兜底稳定排序
  const tagList = useMemo(
    () =>
      refs
        .filter((e) => e.kind === "tag")
        .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name)),
    [refs],
  );

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
      {det && (
        <button
          onClick={() => {
            const head = commits.find((c) => c.refs.includes("HEAD"));
            if (head) void selectRefTip(head.id);
          }}
          title="分离 HEAD：点击定位该提交；写操作需先从此处新建分支"
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-xs font-medium text-warn transition-colors hover:bg-hover"
        >
          <GitBranch size={11} aria-hidden className="shrink-0" />
          <span className="truncate">HEAD（分离）→ {det.short}</span>
        </button>
      )}
      {tree.roots.map(([name, id]) => (
        <BranchRow
          key={name}
          name={name}
          fullName={name}
          tip={id}
          current={summary?.branch === name}
          summary={summary}
          onSelect={() => void selectRefTip(id)}
          onContextMenu={(e) => openBranchMenu(e, name)}
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
                  onSelect={() => void selectRefTip(id)}
                  onContextMenu={(e) => openBranchMenu(e, prefix + "/" + rest)}
                />
              ))}
          </div>
        );
      })}

      {branchMenu && (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          items={buildBranchMenu(branchMenu.target, menuActions)}
          onClose={() => setBranchMenu(null)}
        />
      )}

      {remoteMenu && (
        <ContextMenu
          x={remoteMenu.x}
          y={remoteMenu.y}
          items={buildRemoteMenu(remoteMenu.target, menuActions)}
          onClose={() => setRemoteMenu(null)}
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

      {tagList.length > 0 && (
        <>
          <h4 className="section-label pb-1.5 pt-4">标签</h4>
          {tagList.map(({ name, tip }) => (
            <button
              key={name}
              onClick={() => void selectRefTip(tip)}
              title={name + " → " + tip.slice(0, 7)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-xs text-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <Tag size={11} aria-hidden className="shrink-0 text-warn/80" />
              <span className="truncate">{name}</span>
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
                        onClick={() => void selectRefTip(id)}
                        onContextMenu={(e) => openRemoteMenu(e, remote, name, full)}
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
                                onClick={() => void selectRefTip(id)}
                                onContextMenu={(e) => openRemoteMenu(e, remote, prefix + "/" + rest, full)}
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

