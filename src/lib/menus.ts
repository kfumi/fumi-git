// 三份右键菜单的动作集（ui-spec §4「菜单条目组织」+ 2026-10-11「右键菜单对齐批次」增补）。
//
// 纯函数模块：只把「目标对象 + 可用动作」翻译成 MenuItem[]，不依赖 React、不读写 store，
// 也不碰 DOM —— 组件负责铺 MenuActions、记 {x, y, target} 并渲染 <ContextMenu>。
// 这样禁用规则与文案只有一处定义，且能像 refs.ts / lane.ts 一样被 vitest 直接断言。
//
// 后续工单逐步补齐动作（动作缺席即该项不出现，**不得留点了没反应的占位项**）：
//   03 远程分支检出/推送/抓取/删除远程分支 · 04 上游管理与推送抓取 · 05 新建标签
//   06 检出该修订（分离 HEAD）· 07 变基 · 08 与 HEAD 比较 · 09 修改提交信息
import type { MenuItem, MenuSeparator } from "../components/ContextMenu";

/** 组件把 store 动作铺成这个包；指向具体对象的动作由调用方补上参数 */
export interface MenuActions {
  /** 检出本地分支 */
  checkout: (branch: string) => void;
  /** 把某个 ref（本地分支名或远程 ref 名）合并到当前分支 */
  mergeBranch: (ref: string) => void;
  /** 以某个 ref（提交 id / 分支名 / 远程 ref）为起点新建分支；label 用于对话框文案（如「分支 feat/x」） */
  createBranchFrom: (ref: string, label: string) => void;
  /** 复制文本到剪贴板（成功后 toast `<label>已复制`） */
  copy: (text: string, label: string) => void;
  /** 选中该提交并确保右栏详情打开 */
  showDetail: (commitId: string) => void;
  /** 复制该提交的完整信息（subject + body，按需拉取） */
  copyCommitMessage: (commitId: string) => void;
  /** 拣选（cherry-pick）该提交 */
  cherryPick: (commitId: string) => void;
  /** 反转提交（revert） */
  revert: (commitId: string) => void;
  /** 把当前分支重置到该提交 */
  resetTo: (commitId: string) => void;
  /** 重命名该分支 */
  renameBranch: (branch: string) => void;
  /** 删除该本地分支 */
  deleteBranch: (branch: string) => void;

  // ── 以下由后续工单接入；不传即对应菜单项不出现 ──
  /** 03：检出远程分支（建同名本地跟踪分支并检出） */
  checkoutRemote?: (fullRef: string, branch: string) => void;
  /** 03：把同名本地分支推到该远程 */
  pushToRemote?: (remote: string, branch: string) => void;
  /** 03 / 04：抓取；带远程名时只抓该远程，缺省抓全部 */
  fetch?: (remote?: string) => void;
  /** 03：删除远程分支 */
  deleteRemoteBranch?: (remote: string, branch: string) => void;
  /** 04：设置上游分支 */
  setUpstream?: (branch: string) => void;
  /** 04：取消上游关联 */
  unsetUpstream?: (branch: string) => void;
  /** 04：推送某个本地分支（无上游时走「建立上游关联并推送」） */
  pushBranch?: (branch: string) => void;
  /** 04：抓取某个本地分支对应的远程（无上游时全量抓取） */
  fetchForBranch?: (branch: string) => void;
  /** 05：在该提交上新建标签 */
  createTag?: (commitId: string) => void;
  /** 06：检出该修订（分离 HEAD） */
  checkoutCommit?: (commitId: string) => void;
  /** 07：把当前分支变基到某个 ref */
  rebaseOnto?: (ref: string) => void;
  /** 08：与 HEAD 比较 */
  compareWithHead?: (commitId: string) => void;
  /** 09：修改该提交的信息（仅 HEAD） */
  amendMessage?: (commitId: string) => void;
}

/** 侧栏本地分支菜单需要的动作（后续工单接入的仍是可选，缺席即该项不出现） */
export type BranchMenuActions = Pick<
  MenuActions,
  | "checkout"
  | "mergeBranch"
  | "createBranchFrom"
  | "copy"
  | "renameBranch"
  | "deleteBranch"
  | "rebaseOnto"
  | "setUpstream"
  | "unsetUpstream"
  | "pushBranch"
  | "fetchForBranch"
>;

/** 侧栏远程分支菜单需要的动作 */
export type RemoteMenuActions = Pick<
  MenuActions,
  | "checkout"
  | "mergeBranch"
  | "createBranchFrom"
  | "copy"
  | "rebaseOnto"
  | "checkoutRemote"
  | "pushToRemote"
  | "fetch"
  | "deleteRemoteBranch"
>;

/** 历史列表提交菜单需要的动作 */
export type CommitMenuActions = Pick<
  MenuActions,
  | "checkout"
  | "mergeBranch"
  | "createBranchFrom"
  | "copy"
  | "showDetail"
  | "copyCommitMessage"
  | "cherryPick"
  | "revert"
  | "resetTo"
  | "compareWithHead"
  | "checkoutCommit"
  | "createTag"
  | "amendMessage"
>;

/** 侧栏本地分支行 */
export interface BranchTarget {
  /** 分支短名（含前缀，如 feat/login） */
  name: string;
  /** 是否当前分支 */
  current: boolean;
  /** 上游（`%(upstream:short)`；04 之后由 refs 提供，未提供视为未知） */
  upstream?: string | null;
  /** 分离 HEAD（无当前分支）：推送/抓取/合并/变基/重命名/删除/上游类动作一律禁用并提示 */
  detached: boolean;
}

/** 侧栏远程分支行 */
export interface RemoteTarget {
  /** 远程名（ref 名首段，如 origin） */
  remote: string;
  /** 去掉远程前缀的分支名（如 feat/login） */
  branch: string;
  /** 完整 ref 名（如 origin/feat/login） */
  full: string;
  /** 本地是否已有同名分支 */
  hasLocal: boolean;
  /** 分离 HEAD（无当前分支）：同步类动作禁用并提示 */
  detached: boolean;
}

/** 历史列表的提交行 */
export interface CommitTarget {
  id: string;
  /** 短 id（用于 hint / 文案） */
  short: string;
  /** 该提交上挂的本地分支名（按 refs 顺序） */
  branches: string[];
  /** 是否当前 HEAD 提交（无 HEAD 时 false） */
  isHead: boolean;
  /** 当前分支名；分离 HEAD 为 null */
  currentBranch: string | null;
}

const SEPARATOR: MenuSeparator = { kind: "separator" };

/** 分离 HEAD 下写操作禁用时的统一提示（ui-spec §4 分离 HEAD 矩阵） */
export const DETACHED_HINT = "先从此处新建分支";

/**
 * 分离 HEAD 判定：后端 `current_branch()` 在分离态返回 `(HEAD detached at <短号>)`，
 * 这里按该格式解出短号（侧栏状态行与工具栏用）；不在分离态返回 null。
 */
export function detachedHead(summary: { branch: string } | null): { short: string } | null {
  const m = summary?.branch.match(/^\(HEAD detached at ([0-9a-f]+)\)$/);
  return m ? { short: m[1] } : null;
}

/** 按语义分组拼接，空组直接丢弃（不留悬空分隔线） */
function grouped(groups: MenuItem[][]): MenuItem[] {
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) => (i === 0 ? g : [SEPARATOR, ...g]));
}

/** 侧栏「本地分支」右键菜单 */
export function branchMenu(t: BranchTarget, a: BranchMenuActions): MenuItem[] {
  // 分离 HEAD：写操作禁用并统一提示（检出、新建分支、复制类不受影响）
  const off = t.detached ? DETACHED_HINT : undefined;
  const move: MenuItem[] = [
    {
      label: "检出",
      hint: t.current ? "当前分支" : "checkout",
      disabled: t.current,
      onSelect: () => a.checkout(t.name),
    },
    {
      label: "从此处新建分支…",
      onSelect: () => a.createBranchFrom(t.name, `分支 ${t.name}`),
    },
    {
      label: "合并到当前分支…",
      hint: t.detached ? off : t.current ? "当前分支" : undefined,
      disabled: t.current || t.detached,
      onSelect: () => a.mergeBranch(t.name),
    },
  ];
  if (a.rebaseOnto) {
    move.push({
      label: "将当前分支变基到此分支…",
      hint: t.detached ? off : t.current ? "当前分支" : "rebase",
      disabled: t.current || t.detached,
      onSelect: () => a.rebaseOnto!(t.name),
    });
  }

  const manage: MenuItem[] = [
    {
      label: "重命名…",
      hint: off,
      disabled: t.detached,
      onSelect: () => a.renameBranch(t.name),
    },
  ];
  const hasUpstream = Boolean(t.upstream);
  if (a.setUpstream) {
    manage.push({
      label: "设置上游分支…",
      hint: t.detached ? off : hasUpstream ? "已有 upstream" : undefined,
      disabled: hasUpstream || t.detached,
      onSelect: () => a.setUpstream!(t.name),
    });
  }
  if (a.unsetUpstream) {
    manage.push({
      label: "取消上游关联",
      hint: off,
      disabled: !hasUpstream || t.detached,
      onSelect: () => a.unsetUpstream!(t.name),
    });
  }
  manage.push({
    label: "删除…",
    hint: t.detached ? off : t.current ? "当前分支" : undefined,
    disabled: t.current || t.detached,
    danger: true,
    onSelect: () => a.deleteBranch(t.name),
  });

  const sync: MenuItem[] = [{ label: "复制分支名", onSelect: () => a.copy(t.name, "分支名") }];
  if (a.pushBranch) {
    sync.push({
      label: "推送",
      hint: off,
      disabled: t.detached,
      onSelect: () => a.pushBranch!(t.name),
    });
  }
  if (a.fetchForBranch) {
    sync.push({
      label: "抓取",
      hint: off,
      disabled: t.detached,
      onSelect: () => a.fetchForBranch!(t.name),
    });
  }

  return grouped([move, manage, sync]);
}

/** 侧栏「远程分支」右键菜单 */
export function remoteMenu(t: RemoteTarget, a: RemoteMenuActions): MenuItem[] {
  const off = t.detached ? DETACHED_HINT : undefined;
  const move: MenuItem[] = [
    {
      label: "检出",
      hint: t.hasLocal ? "本地已有同名分支" : "checkout",
      disabled: t.hasLocal || !a.checkoutRemote,
      onSelect: () => a.checkoutRemote?.(t.full, t.branch),
    },
    {
      label: "从此处新建分支…",
      onSelect: () => a.createBranchFrom(t.full, `远程分支 ${t.full}`),
    },
    {
      label: "合并到当前分支…",
      hint: off,
      disabled: t.detached,
      onSelect: () => a.mergeBranch(t.full),
    },
  ];
  if (a.rebaseOnto) {
    move.push({
      label: "将当前分支变基到此分支…",
      hint: off ?? "rebase",
      disabled: t.detached,
      onSelect: () => a.rebaseOnto!(t.full),
    });
  }

  const manage: MenuItem[] = [];
  if (a.deleteRemoteBranch) {
    manage.push({
      label: "删除远程分支…",
      danger: true,
      onSelect: () => a.deleteRemoteBranch!(t.remote, t.branch),
    });
  }

  const sync: MenuItem[] = [{ label: "复制分支名", onSelect: () => a.copy(t.full, "分支名") }];
  if (a.pushToRemote) {
    sync.push({
      label: "推送",
      hint: t.detached ? off : t.hasLocal ? undefined : "无同名本地分支",
      disabled: !t.hasLocal || t.detached,
      onSelect: () => a.pushToRemote!(t.remote, t.branch),
    });
  }
  if (a.fetch) {
    sync.push({
      label: "抓取",
      hint: off,
      disabled: t.detached,
      onSelect: () => a.fetch!(t.remote),
    });
  }

  return grouped([move, manage, sync]);
}

/** 历史列表「提交」右键菜单 */
export function commitMenu(t: CommitTarget, a: CommitMenuActions): MenuItem[] {
  // 第一组：按提交上挂的本地分支动态长出（FumiGit 特有，保留）
  const refs: MenuItem[] = [];
  for (const b of t.branches) {
    const isCurrent = b === t.currentBranch;
    refs.push({
      label: `检出到 ${b}`,
      hint: isCurrent ? "当前分支" : "checkout",
      disabled: isCurrent,
      onSelect: () => a.checkout(b),
    });
    if (!isCurrent) {
      refs.push({
        label: `合并 ${b} 到当前分支…`,
        onSelect: () => a.mergeBranch(b),
      });
    }
  }

  const inspect: MenuItem[] = [
    { label: "显示差异", onSelect: () => a.showDetail(t.id) },
    { label: "复制修订号", hint: t.short, onSelect: () => a.copy(t.id, "修订号") },
    { label: "复制提交信息", onSelect: () => a.copyCommitMessage(t.id) },
  ];

  const derive: MenuItem[] = [];
  if (a.compareWithHead) {
    derive.push({
      label: "与 HEAD 比较",
      hint: t.isHead ? "就是 HEAD" : undefined,
      disabled: t.isHead,
      onSelect: () => a.compareWithHead!(t.id),
    });
  }
  if (a.checkoutCommit) {
    derive.push({
      label: "检出该修订…",
      hint: t.isHead ? "当前 HEAD" : "detached",
      disabled: t.isHead,
      onSelect: () => a.checkoutCommit!(t.id),
    });
  }
  derive.push({
    label: "从此处新建分支…",
    onSelect: () => a.createBranchFrom(t.id, `提交 ${t.short}`),
  });
  if (a.createTag) {
    derive.push({ label: "新建标签…", onSelect: () => a.createTag!(t.id) });
  }

  const rewrite: MenuItem[] = [
    { label: "拣选…", hint: "cherry-pick", onSelect: () => a.cherryPick(t.id) },
    { label: "反转提交…", hint: "revert", onSelect: () => a.revert(t.id) },
    {
      label: `将当前分支重置到此处…`,
      danger: true,
      onSelect: () => a.resetTo(t.id),
    },
  ];
  if (a.amendMessage) {
    rewrite.push({
      label: "修改提交信息…",
      hint: t.isHead ? undefined : "仅 HEAD",
      disabled: !t.isHead,
      onSelect: () => a.amendMessage!(t.id),
    });
  }

  return grouped([refs, inspect, derive, rewrite]);
}
