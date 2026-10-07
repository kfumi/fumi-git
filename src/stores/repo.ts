// 主 store：仓库、提交日志、选中、详情、工作区、同步动作。
// IPC 返回视为类型化契约（见 docs/agents 域规则），本模块是前端唯一业务状态源。
import { create } from "zustand";
import { asGitError, ipc } from "../lib/ipc";
import { applyBlockChoice, parseConflictBlocks } from "../lib/conflict";
import type {
  AppConfig,
  BranchSummary,
  CommitDetail,
  CommitEntry,
  ConflictVersions,
  FileEntry,
  GitOperation,
  RepoMeta,
  RepoStatus,
  StashEntry,
} from "../lib/types";

/** operation 文案单一来源（横幅 / 继续按钮 / toast 共用） */
export const OPERATION_LABEL: Record<GitOperation, { progress: string; cont: string }> = {
  merge: { progress: "合并进行中", cont: "继续合并" },
  "cherry-pick": { progress: "摘取（cherry-pick）进行中", cont: "继续摘取" },
  revert: { progress: "还原（revert）进行中", cont: "继续还原" },
};

const PAGE = 200;

export interface Toast {
  id: number;
  kind: "ok" | "err" | "busy";
  text: string;
}

/**
 * 对话框动作按钮。run 的返回值约定（由 DialogHost 解释）：
 * undefined/void = 关闭；false = 保持打开（无提示）；string = 保持打开并显示错误。
 * 可为 Promise（异步校验期间按钮禁用）。
 */
export interface DialogAction {
  label: string;
  kind?: "primary" | "danger" | "ghost";
  run: (input: string, checked: boolean) => string | false | void | Promise<string | false | void>;
}

/** 通用对话框描述（ui-spec §4）：确认 / 多选去向 / 输入表单统一走这一槽位 */
export interface DialogDesc {
  title: string;
  message?: string;
  /** 受影响文件清单（脏工作树拦截） */
  files?: string[];
  /** validate 随输入即时回调（表单即时校验，US4） */
  input?: {
    initial?: string;
    placeholder?: string;
    validate?: (value: string) => string | null;
  };
  checkbox?: { label: string; initial?: boolean };
  /** 取消按钮标签；缺省「取消」；actions 已含取消项时传 null */
  cancelLabel?: string | null;
  actions: DialogAction[];
}

let toastSeq = 0;

interface RepoState {
  config: AppConfig | null;
  meta: RepoMeta | null;
  commits: CommitEntry[];
  logDone: boolean;
  loadingMore: boolean;
  selectedId: string | null;
  detail: CommitDetail | null;
  detailLoading: boolean;
  /** 提交详情里已打开的文件 diff tab（路径，有序）与当前激活项 */
  openFiles: string[];
  detailFile: string | null;
  /** 中栏 tab：历史（图谱）为默认主角 */
  mainTab: "changes" | "history";
  /** 改动 tab 中选中的工作区文件及其 diff（staged 区分已暂存/未暂存两个列表的同名文件） */
  workFile: string | null;
  workStaged: boolean;
  workDiff: string | null;
  workDiffLoading: boolean;
  /** 侧栏引用点击跳转：目标提交 id + 触发序号（GraphList 据此滚动置顶） */
  scrollToId: string | null;
  scrollNonce: number;
  status: RepoStatus | null;
  summary: BranchSummary | null;
  filter: string;
  toasts: Toast[];
  /** 当前打开的通用对话框；null = 关闭 */
  dialog: DialogDesc | null;
  /** 有写操作在飞：期间拒绝再发起其它写操作（US31 防重复触发） */
  writeBusy: boolean;
  /** stash 条目列表（0 = 最新） */
  stashes: StashEntry[];
  /** 正在查看的 stash 条目及其 diff；null = 收起 */
  stashView: { index: number; patch: string | null; loading: boolean } | null;
  /** 冲突解决视图：{ 路径, 三方版本, 工作区结果原文 }；null = 收起 */
  conflictView: {
    path: string;
    versions: ConflictVersions | null;
    result: string | null;
    loading: boolean;
  } | null;

  hydrate: () => Promise<void>;
  openRepo: (path: string) => Promise<boolean>;
  removeRecent: (path: string) => Promise<void>;
  closeRepo: () => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  /** 打开（或激活）提交详情的一个文件 diff tab */
  openDetailFile: (path: string) => void;
  /** 关闭文件 diff tab；关闭激活项时自动激活相邻 tab */
  closeDetailFile: (path: string) => void;
  /** 选中改动 tab 的工作区文件（null = 收起 diff）；再次选中同文件则取消选中 */
  selectWorkFile: (path: string | null, staged?: boolean) => Promise<void>;
  /** 直接拉取工作区文件 diff（无 toggle 语义，refresh 复用） */
  reloadWorkDiff: (path: string, staged: boolean) => Promise<void>;
  setMainTab: (tab: "changes" | "history") => void;
  /** 侧栏点击分支/标签/远程：选中其 tip 提交并让列表滚动置顶 */
  selectRefTip: (id: string) => void;
  /** 关闭右栏面板：改动 tab 收起工作文件 diff，历史 tab 取消选中提交 */
  closeRightPane: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<boolean>;
  remote: (op: "fetch" | "pull" | "push") => Promise<void>;
  setFilter: (f: string) => void;
  pushToast: (kind: Toast["kind"], text: string) => number;
  /** 就地改写某条提示（busy → ok/err 的转场复用同一条，不打断视线） */
  updateToast: (id: number, patch: Partial<Pick<Toast, "kind" | "text">>) => void;
  dismissToast: (id: number) => void;
  openDialog: (desc: DialogDesc) => void;
  closeDialog: () => void;
  /** 迁出到本地分支；脏工作树时先经安全拦截对话框（ui-spec §4） */
  checkout: (branch: string) => Promise<void>;
  /** 新建分支（对话框表单：名称 + 建完即迁出勾选）；返回校验错误给对话框显示 */
  createBranch: (name: string, checkoutAfter: boolean, at?: string) => Promise<string | void>;
  /** 新建分支对话框入口；at 缺省基于当前 HEAD，传入提交 id 则基于该提交 */
  createBranchFlow: (atCommit?: string) => void;
  /** 删除分支入口：先取未合入计数，按结果弹一次确认或强制删除确认 */
  deleteBranchFlow: (branch: string) => Promise<void>;
  /** 分支改名（对话框表单，预填原名） */
  renameBranchFlow: (branch: string) => void;
  /** 重置当前分支到指定提交（图谱右键入口）：先选模式，硬重置必过脏树拦截 */
  resetBranchTo: (commitId: string) => void;
  /** push 无上游时的建立关联弹框（选远程 → push -u） */
  pushUpstreamFlow: () => Promise<void>;
  /** 分叉拉取：把上游分支合并进当前分支（确认后由 remote('pull') 错误处理触发） */
  mergeUpstreamFlow: (refName: string) => Promise<void>;
  /** 中止进行中的合并，恢复到合并前状态 */
  abortOperation: () => Promise<void>;
  /** stash 入口：对话框附可选描述，暂存全部改动（含未跟踪） */
  stashFlow: () => void;
  /** 选中/收起 stash 条目，右栏查看其只读 diff */
  selectStash: (index: number) => Promise<void>;
  /** 恢复 stash：pop=true 成功后移除条目（冲突时 git 自动保留），pop=false 保留副本 */
  stashRestore: (index: number, pop: boolean) => Promise<void>;
  /** 删除 stash 条目（带确认） */
  stashDropFlow: (index: number) => void;
  /** 打开/收起冲突文件的三方解决视图 */
  openConflict: (path: string) => Promise<void>;
  /** 选边解决：整个文件采用我方/对方版本（选边即标记已解决） */
  resolveTakeFlow: (path: string, ours: boolean) => Promise<void>;
  /** 标记冲突文件已解决（仍有冲突标记时先警示） */
  markResolvedFlow: (path: string) => Promise<void>;
  /** 完成进行中的操作（冲突清空后可用） */
  continueOperationFlow: () => Promise<void>;
  /** 在系统默认应用中打开文件（手动编辑冲突） */
  openConflictInEditor: (path: string) => Promise<void>;
  /** 冲突块逐块取舍：把第 index 块替换为所选一侧内容并写回工作区（不自动 add） */
  applyConflictBlock: (path: string, blockIndex: number, side: "ours" | "theirs") => Promise<void>;
  /** 摘取提交到当前分支（脏树拒绝；空提交给跳过/放弃选择） */
  cherryPickFlow: (commitId: string) => Promise<void>;
  /** 还原提交（合并提交解释性拦截；冲突进 operation=revert 流程） */
  revertFlow: (commitId: string) => Promise<void>;
  /** 把本地分支合并进当前分支（冲突进 operation=merge 流程） */
  mergeBranchFlow: (branch: string) => Promise<void>;
  /**
   * 丢弃工作区改动（US22–25，支持批量多选）：未暂存组 M/D → 从 index 恢复，
   * 'A'（未跟踪）→ 删除文件；均带不可恢复确认。
   */
  discardWorktreeFlow: (files: FileEntry[]) => void;
  /**
   * 丢弃已暂存改动（支持批量多选）：'A' → 从 index 移除并删文件，
   * M/D/R → index+工作区一起退回 HEAD（重命名连带 old_path）；带不可恢复确认。
   */
  discardStagedFlow: (files: FileEntry[]) => void;
  discardAllFlow: () => void;
}

const errText = async (e: unknown): Promise<string> => {
  const err = await asGitError(e);
  // git 自身拦截（如迁出/合并时改动会被覆盖）的常见场景给可读中文（US32）
  if (/would be overwritten|local changes/i.test(err.message)) {
    return "操作失败：工作区改动会与目标冲突，请先提交或 stash 后重试";
  }
  return `操作失败：${err.message}`;
};

/** 分支名客户端预检（表单即时反馈；后端仍以 check-ref-format 为准） */
const BAD_BRANCH_CHARS = new Set([" ", "~", "^", ":", "?", "*", "[", "]", "\\", "\t"]);

/** 写操作前的脏工作树预检（cherry-pick / revert 等不允许带脏树进行） */
async function ensureCleanTree(get: () => RepoState): Promise<boolean> {
  const st = await ipc.getStatus().catch(() => null);
  if (st && (st.staged.length > 0 || st.unstaged.length > 0 || st.unmerged.length > 0)) {
    get().pushToast("err", "工作区不干净：请先提交改动或 stash 后再操作");
    return false;
  }
  return true;
}

export function validateBranchName(name: string): string | null {
  const n = name.trim();
  if (!n) return "分支名不能为空";
  if (
    [...n].some((ch) => BAD_BRANCH_CHARS.has(ch)) ||
    n.includes("..") ||
    /^[.\-]/.test(n) ||
    n.endsWith(".lock")
  ) {
    return "非法分支名（不能含空格 ~ ^ : ? * [ \\，不能以 . 或 - 开头）";
  }
  return null;
}

/**
 * 通用写操作包裹（US31）：writeBusy 期间拒绝新写操作；
 * busy 提示就地转场为 op 返回的文案（ok）或结构化错误（err），完成后刷新。
 */
async function runWrite(
  set: (partial: Partial<RepoState>) => void,
  get: () => RepoState,
  busyText: string,
  okText: string,
  op: () => Promise<string | void>,
): Promise<void> {
  if (get().writeBusy) {
    get().pushToast("err", "有操作正在进行中，请稍候");
    return;
  }
  set({ writeBusy: true });
  const id = get().pushToast("busy", busyText);
  try {
    const msg = await op();
    get().updateToast(id, { kind: "ok", text: typeof msg === "string" && msg ? msg : okText });
    await get().refresh();
  } catch (e) {
    get().updateToast(id, { kind: "err", text: await errText(e) });
  } finally {
    set({ writeBusy: false });
  }
}

export const useRepo = create<RepoState>((set, get) => ({
  config: null,
  meta: null,
  commits: [],
  logDone: false,
  loadingMore: false,
  selectedId: null,
  detail: null,
  detailLoading: false,
  openFiles: [],
  detailFile: null,
  mainTab: "changes",
  workFile: null,
  workStaged: false,
  workDiff: null,
  workDiffLoading: false,
  scrollToId: null,
  scrollNonce: 0,
  status: null,
  summary: null,
  filter: "",
  toasts: [],
  dialog: null,
  writeBusy: false,
  stashes: [],
  stashView: null,
  conflictView: null,

  openDialog: (desc) => set({ dialog: desc }),
  closeDialog: () => set({ dialog: null }),

  checkout: async (branch) => {
    const st = await ipc.getStatus().catch(() => null);
    const dirtyFiles = st ? [...st.staged, ...st.unstaged].map((f) => f.path) : [];
    const doSwitch = () =>
      runWrite(set, get, `迁出到 ${branch}…`, `已迁出到 ${branch}`, async () => {
        await ipc.switchBranch(branch);
      });
    if (dirtyFiles.length > 0) {
      get().openDialog({
        title: `迁出到 ${branch}`,
        message:
          "工作区有未提交改动。带着改动迁出时，若与目标分支冲突，git 会拒绝且现状不变。",
        files: dirtyFiles,
        actions: [
          { label: "带着改动迁出", kind: "primary", run: () => void doSwitch() },
          {
            label: "stash 后迁出",
            kind: "ghost",
            run: () => {
              void (async () => {
                try {
                  await ipc.stashPush("迁出前自动暂存");
                  get().pushToast("ok", "改动已存入 stash，可随时恢复");
                  await doSwitch();
                } catch (e) {
                  get().pushToast("err", await errText(e));
                }
              })();
            },
          },
        ],
      });
      return;
    }
    await doSwitch();
  },

  createBranch: async (name, checkoutAfter, at) => {
    const trimmed = name.trim();
    if (!trimmed) return "分支名不能为空";
    try {
      await ipc.createBranch(trimmed, checkoutAfter, at);
      get().pushToast(
        "ok",
        checkoutAfter ? `已创建并迁出到 ${trimmed}` : `已创建分支 ${trimmed}`,
      );
      await get().refresh();
    } catch (e) {
      return (await asGitError(e)).message;
    }
  },

  createBranchFlow: (atCommit) => {
    const short = atCommit ? atCommit.slice(0, 7) : "";
    get().openDialog({
      title: "新建分支",
      message: atCommit ? `基于提交 ${short} 创建新分支。` : "基于当前 HEAD 创建新分支。",
      input: { placeholder: "分支名，如 feat/login", validate: validateBranchName },
      checkbox: { label: "创建后立即迁出", initial: true },
      actions: [
        {
          label: "创建",
          kind: "primary",
          run: (name, checkoutAfter) => get().createBranch(name, checkoutAfter, atCommit),
        },
      ],
    });
  },

  deleteBranchFlow: async (branch) => {
    let unmerged = 0;
    try {
      unmerged = await ipc.branchUnmergedCount(branch);
    } catch (e) {
      get().pushToast("err", await errText(e));
      return;
    }
    const forceDelete = () => {
      get().openDialog({
        title: "确认强制删除",
        message: `将丢弃 ${branch} 上 ${unmerged} 个未合入的提交，删除后这些提交很难找回。`,
        actions: [
          {
            label: `强制删除（丢弃 ${unmerged} 个提交）`,
            kind: "danger",
            run: () => {
              void runWrite(set, get, `删除分支 ${branch}…`, `已删除分支 ${branch}`, async () => {
                await ipc.deleteBranch(branch, true);
              });
            },
          },
        ],
      });
    };
    if (unmerged > 0) {
      // 未合入分支：先展示计数，再做一次强制删除确认（spec 决策 #5 双保险）
      get().openDialog({
        title: `删除分支 ${branch}`,
        message: `该分支有 ${unmerged} 个提交未合入当前分支。继续将进入强制删除确认。`,
        actions: [{ label: "继续", run: () => forceDelete() }],
      });
    } else {
      get().openDialog({
        title: `删除分支 ${branch}`,
        message: "该分支已全部合入当前分支。删除后分支引用不可恢复。",
        actions: [
          {
            label: "删除分支",
            kind: "danger",
            run: () => {
              void runWrite(set, get, `删除分支 ${branch}…`, `已删除分支 ${branch}`, async () => {
                await ipc.deleteBranch(branch, false);
              });
            },
          },
        ],
      });
    }
  },

  renameBranchFlow: (branch) => {
    get().openDialog({
      title: "重命名分支",
      input: {
        initial: branch,
        validate: (v) => (v.trim() === branch ? null : validateBranchName(v)),
      },
      actions: [
        {
          label: "重命名",
          kind: "primary",
          run: async (name) => {
            const newName = name.trim();
            if (!newName || newName === branch) return false;
            try {
              await ipc.renameBranch(branch, newName);
              get().pushToast("ok", `已重命名分支：${branch} → ${newName}`);
              await get().refresh();
            } catch (e) {
              return (await asGitError(e)).message;
            }
          },
        },
      ],
    });
  },

  resetBranchTo: (commitId) => {
    const branch = get().summary?.branch ?? get().meta?.branch ?? "";
    const short = commitId.slice(0, 7);
    const doReset = (mode: "soft" | "mixed" | "hard") => {
      void runWrite(
        set,
        get,
        `重置 ${branch} 到 ${short}…`,
        `已重置 ${branch} 到 ${short}`,
        async () => {
          await ipc.resetBranch(commitId, mode);
        },
      );
    };
    // 硬重置销毁未提交改动：脏树时先过安全拦截（与迁出共用模型）
    const confirmHard = async () => {
      const st = await ipc.getStatus().catch(() => null);
      const dirtyFiles = st ? [...st.staged, ...st.unstaged].map((f) => f.path) : [];
      if (dirtyFiles.length === 0) {
        doReset("hard");
        return;
      }
      get().openDialog({
        title: "硬重置将丢弃未提交改动",
        message: "硬重置会把工作区与暂存区一起退回目标提交，下列改动将无法找回。",
        files: dirtyFiles,
        actions: [
          { label: "硬重置（丢弃改动）", kind: "danger", run: () => doReset("hard") },
          {
            label: "stash 后硬重置",
            run: () => {
              void (async () => {
                try {
                  await ipc.stashPush("硬重置前自动暂存");
                  get().pushToast("ok", "改动已存入 stash，可随时恢复");
                  doReset("hard");
                } catch (e) {
                  get().pushToast("err", await errText(e));
                }
              })();
            },
          },
        ],
      });
    };
    get().openDialog({
      title: "重置当前分支到此提交",
      message: `分支 ${branch} 将指向 ${short}，其后的提交从分支历史移除。软重置：改动保留在暂存区；混合重置：改动保留在工作区；硬重置：改动全部丢弃（脏工作树会先拦截确认）。`,
      actions: [
        { label: "软重置", run: () => doReset("soft") },
        { label: "混合重置", run: () => doReset("mixed") },
        { label: "硬重置", kind: "danger", run: () => void confirmHard() },
      ],
    });
  },

  pushToast: (kind, text) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    return id;
  },
  updateToast: (id, patch) =>
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  hydrate: async () => {
    const cfg = await ipc.getConfig();
    set({ config: cfg });
  },

  openRepo: async (path) => {
    try {
      const meta = await ipc.openRepo(path);
      set({
        meta,
        commits: [],
        logDone: false,
        selectedId: null,
        detail: null,
        openFiles: [],
        detailFile: null,
        workFile: null,
        workStaged: false,
        workDiff: null,
        workDiffLoading: false,
        status: null,
        summary: null,
        filter: "",
        dialog: null,
        stashes: [],
        stashView: null,
        conflictView: null,
      });
      await get().refresh();
      // 刷新最近列表
      set({ config: await ipc.getConfig() });
      return true;
    } catch (e) {
      get().pushToast("err", await errText(e));
      return false;
    }
  },

  removeRecent: async (path) => {
    await ipc.removeRecent(path);
    set({ config: await ipc.getConfig() });
  },

  closeRepo: () =>
    set({
      meta: null,
      commits: [],
      selectedId: null,
      detail: null,
      openFiles: [],
      detailFile: null,
      workFile: null,
      workStaged: false,
      workDiff: null,
      workDiffLoading: false,
      status: null,
      summary: null,
      dialog: null,
      stashes: [],
      stashView: null,
      conflictView: null,
    }),

  loadMore: async () => {
    const { meta, commits, logDone, loadingMore } = get();
    if (!meta || logDone || loadingMore) return;
    set({ loadingMore: true });
    try {
      // 页大小随深度几何增长：--topo-order 每页都要全量走历史（性能 smoke 实测），
      // 固定小页会让深滚动退化成 O(页数 × 历史长度)；大页把总次数压到 ~log 级。
      const limit = Math.max(PAGE, Math.floor(commits.length / 4));
      const page = await ipc.getLog(commits.length, limit);
      const seen = new Set(commits.map((c) => c.id));
      const fresh = page.commits.filter((c) => !seen.has(c.id));
      set({ commits: [...commits, ...fresh], logDone: page.done, loadingMore: false });
    } catch (e) {
      set({ loadingMore: false });
      get().pushToast("err", await errText(e));
    }
  },

  refresh: async () => {
    const { meta, selectedId } = get();
    if (!meta) return;
    try {
      const [page, status, summary, stashes] = await Promise.all([
        ipc.getLog(0, Math.max(PAGE, get().commits.length || PAGE)),
        ipc.getStatus().catch(() => null),
        ipc.getBranchSummary().catch(() => null),
        ipc.stashList().catch(() => []),
      ]);
      const stillThere = selectedId && page.commits.some((c) => c.id === selectedId);
      set({
        commits: page.commits,
        logDone: page.done,
        status,
        summary,
        stashes,
        selectedId: stillThere ? selectedId : null,
        detail: stillThere ? get().detail : null,
        openFiles: stillThere ? get().openFiles : [],
        detailFile: stillThere ? get().detailFile : null,
      });
      // 工作区选中文件可能已被提交/外部变更移走：仍在对应列表则刷新 diff，否则收起
      const wf = get().workFile;
      if (wf) {
        const inList = (list: { path: string }[]) => list.some((f) => f.path === wf);
        const still =
          !!status && (get().workStaged ? inList(status.staged) : inList(status.unstaged));
        if (still) void get().reloadWorkDiff(wf, get().workStaged);
        else set({ workFile: null, workDiff: null, workDiffLoading: false });
      }
      // 查看中的 stash 条目已消失（被 pop/drop）→ 收起
      const sv = get().stashView;
      if (sv && !stashes.some((s) => s.index === sv.index)) set({ stashView: null });
      // 查看中的冲突文件已被解决 → 收起
      const cv = get().conflictView;
      if (cv && !(status?.unmerged ?? []).some((f) => f.path === cv.path))
        set({ conflictView: null });
    } catch (e) {
      get().pushToast("err", await errText(e));
    }
  },

  select: async (id) => {
    if (id === null) {
      set({ selectedId: null, detail: null, openFiles: [], detailFile: null });
      return;
    }
    set({ selectedId: id, detailLoading: true });
    try {
      const detail = await ipc.getCommitDetail(id);
      // 换提交后文件 tab 清空，点击文件才展开 diff
      if (get().selectedId === id) set({ detail, detailLoading: false, openFiles: [], detailFile: null });
    } catch (e) {
      if (get().selectedId === id) {
        set({ detail: null, detailLoading: false, openFiles: [], detailFile: null });
        get().pushToast("err", await errText(e));
      }
    }
  },

  openDetailFile: (path) => {
    const { openFiles } = get();
    set(
      openFiles.includes(path)
        ? { detailFile: path }
        : { openFiles: [...openFiles, path], detailFile: path },
    );
  },

  closeDetailFile: (path) => {
    const prev = get().openFiles;
    const openFiles = prev.filter((p) => p !== path);
    let detailFile = get().detailFile;
    if (detailFile === path) {
      const idx = prev.indexOf(path);
      detailFile = openFiles[Math.min(idx, openFiles.length - 1)] ?? null;
    }
    set({ openFiles, detailFile });
  },

  selectWorkFile: async (path, staged = false) => {
    if (path === null) {
      set({ workFile: null, workDiff: null, workDiffLoading: false });
      return;
    }
    // 同一文件再次点击 = 收起
    if (get().workFile === path && get().workStaged === staged && get().workDiff !== null) {
      set({ workFile: null, workDiff: null, workDiffLoading: false });
      return;
    }
    await get().reloadWorkDiff(path, staged);
  },

  reloadWorkDiff: async (path, staged) => {
    set({ workFile: path, workStaged: staged, workDiff: null, workDiffLoading: true });
    try {
      const patch = await ipc.getWorktreeDiff(staged, path);
      if (get().workFile === path && get().workStaged === staged)
        set({ workDiff: patch ?? null, workDiffLoading: false });
    } catch (e) {
      if (get().workFile === path) set({ workDiffLoading: false });
      get().pushToast("err", await errText(e));
    }
  },

  setMainTab: (tab) => set({ mainTab: tab }),

  selectRefTip: (id) => {
    // 跳转目标在历史里：无论当前处于哪个 tab，先切回历史再定位
    set({ mainTab: "history", scrollToId: id, scrollNonce: get().scrollNonce + 1 });
    void get().select(id);
  },

  closeRightPane: () => {
    // 冲突视图 > stash 查看 > 按 tab 语义移除触发条件
    if (get().conflictView) {
      set({ conflictView: null });
      return;
    }
    if (get().stashView) {
      set({ stashView: null });
      return;
    }
    if (get().mainTab === "changes") void get().selectWorkFile(null);
    else void get().select(null);
  },

  stage: async (paths) => {
    try {
      await ipc.stage(paths);
      set({ status: await ipc.getStatus() });
    } catch (e) {
      get().pushToast("err", await errText(e));
    }
  },

  unstage: async (paths) => {
    try {
      await ipc.unstage(paths);
      set({ status: await ipc.getStatus() });
    } catch (e) {
      get().pushToast("err", await errText(e));
    }
  },

  commit: async (message) => {
    try {
      await ipc.commit(message);
      get().pushToast("ok", "提交完成");
      await get().refresh();
      return true;
    } catch (e) {
      get().pushToast("err", await errText(e));
      return false;
    }
  },

  remote: async (op) => {
    const id = get().pushToast(
      "busy",
      op === "fetch" ? "抓取中…" : op === "pull" ? "拉取中…" : "推送中…",
    );
    try {
      const msg = await (op === "fetch" ? ipc.fetch() : op === "pull" ? ipc.pull() : ipc.push());
      get().updateToast(id, { kind: "ok", text: msg });
      await get().refresh();
    } catch (e) {
      const err = await asGitError(e);
      // 分叉拉取 → 引导确认合并（票 04）；推送无上游 → 弹框建立关联
      if (op === "pull" && err.kind === "NonFastForward") {
        get().dismissToast(id);
        const upstream = get().summary?.upstream;
        if (upstream) await get().mergeUpstreamFlow(upstream);
        else get().pushToast("err", await errText(e));
        return;
      }
      if (op === "push" && err.kind === "NoUpstream") {
        get().dismissToast(id);
        await get().pushUpstreamFlow();
        return;
      }
      get().updateToast(id, { kind: "err", text: await errText(e) });
    }
  },

  pushUpstreamFlow: async () => {
    const branch = get().summary?.branch ?? get().meta?.branch ?? "";
    if (!branch || branch.startsWith("(HEAD detached")) {
      get().pushToast("err", "当前不在常规分支上，无法建立上游关联");
      return;
    }
    let remotes: string[] = [];
    try {
      remotes = await ipc.listRemotes();
    } catch (e) {
      get().pushToast("err", await errText(e));
      return;
    }
    if (remotes.length === 0) {
      get().pushToast("err", "仓库没有配置远程，请先在终端 git remote add");
      return;
    }
    get().openDialog({
      title: "推送并建立上游关联",
      message: `分支 ${branch} 还没有上游分支。选择远程后将执行 push -u 并建立关联：`,
      actions: remotes.map((r) => ({
        label: `推送到 ${r}`,
        kind: r === "origin" ? ("primary" as const) : ("ghost" as const),
        run: () => {
          void runWrite(set, get, `推送到 ${r}…`, "", async () => await ipc.pushUpstream(r, branch));
        },
      })),
    });
  },

  mergeUpstreamFlow: async (refName) => {
    if (get().writeBusy) {
      get().pushToast("err", "有操作正在进行中，请稍候");
      return;
    }
    const branch = get().summary?.branch ?? get().meta?.branch ?? "";
    get().openDialog({
      title: "本地与远程分叉",
      message: `无法快进。把 ${refName} 合并到当前分支 ${branch}？`,
      actions: [
        {
          label: `合并 ${refName}`,
          kind: "primary",
          run: () => {
            void (async () => {
              const id = get().pushToast("busy", `合并 ${refName}…`);
              try {
                await ipc.mergeRef(refName);
                get().updateToast(id, { kind: "ok", text: "合并完成" });
                await get().refresh();
              } catch (e) {
                const err = await asGitError(e);
                await get().refresh();
                const st = get().status;
                if (st?.operation === "merge") {
                  get().updateToast(id, {
                    kind: "err",
                    text: `合并产生冲突：${st.unmerged.length} 个冲突文件。解决后暂存提交，或中止合并。`,
                  });
                } else {
                  get().updateToast(id, { kind: "err", text: err.message });
                }
              }
            })();
          },
        },
      ],
    });
  },

  abortOperation: async () => {
    const op = get().status?.operation;
    if (!op) return;
    await runWrite(set, get, "中止操作…", "已中止操作，仓库恢复到操作前", async () => {
      await ipc.abortOperation(op);
    });
  },

  stashFlow: () => {
    get().openDialog({
      title: "暂存到 stash",
      message: "把工作区全部改动（含未跟踪文件）存入 stash。",
      input: { placeholder: "描述（可选）" },
      actions: [
        {
          label: "暂存",
          kind: "primary",
          run: (message) => {
            void runWrite(set, get, "暂存中…", "已暂存到 stash", async () => {
              await ipc.stashPush(message.trim() || undefined);
            });
          },
        },
      ],
    });
  },

  selectStash: async (index) => {
    const cur = get().stashView;
    if (cur?.index === index) {
      set({ stashView: null });
      return;
    }
    set({ stashView: { index, patch: null, loading: true } });
    try {
      const patch = await ipc.stashDiff(index);
      if (get().stashView?.index === index)
        set({ stashView: { index, patch, loading: false } });
    } catch (e) {
      if (get().stashView?.index === index) set({ stashView: { index, patch: null, loading: false } });
      get().pushToast("err", await errText(e));
    }
  },

  stashRestore: async (index, pop) => {
    const id = get().pushToast("busy", pop ? "恢复中（弹出）…" : "恢复中（保留副本）…");
    try {
      await ipc.stashApply(index, pop);
      get().updateToast(id, { kind: "ok", text: pop ? "已恢复并移除 stash 条目" : "已恢复，stash 条目保留" });
      await get().refresh();
    } catch (e) {
      const err = await asGitError(e);
      await get().refresh();
      const stillThere = get().stashes.some((s) => s.index === index);
      get().updateToast(id, {
        kind: "err",
        text:
          err.kind === "CommandFailed" && stillThere && pop
            ? `恢复产生冲突，stash 条目已保留。${err.message}`
            : err.message,
      });
    }
  },

  stashDropFlow: (index) => {
    get().openDialog({
      title: `删除 stash@{${index}}`,
      message: "删除后该存档不可恢复。",
      actions: [
        {
          label: "删除",
          kind: "danger",
          run: () => {
            void runWrite(set, get, "删除 stash 条目…", "已删除 stash 条目", async () => {
              await ipc.stashDrop(index);
            });
          },
        },
      ],
    });
  },

  // ── 丢弃工作区改动（spec US22–25；批量多选；均带不可恢复确认，US31 由 runWrite 守卫） ──

  // ── 冲突解决视图（二阶段票 02；ui-spec §4 安全模型沿用） ──

  openConflict: async (path) => {
    const cur = get().conflictView;
    if (cur?.path === path) {
      set({ conflictView: null });
      return;
    }
    set({ conflictView: { path, versions: null, result: null, loading: true } });
    try {
      const [versions, result] = await Promise.all([
        ipc.conflictVersions(path),
        ipc.readWorktreeFile(path),
      ]);
      if (get().conflictView?.path === path)
        set({ conflictView: { path, versions, result, loading: false } });
    } catch (e) {
      if (get().conflictView?.path === path)
        set({ conflictView: { path, versions: null, result: null, loading: false } });
      get().pushToast("err", await errText(e));
    }
  },

  resolveTakeFlow: async (path, ours) => {
    await runWrite(
      set,
      get,
      `采用${ours ? "我方" : "对方"}版本…`,
      `已采用${ours ? "我方" : "对方"}版本并标记已解决`,
      async () => {
        await ipc.resolveTake(path, ours);
      },
    );
    // 文件已解决 → 收起视图（refresh 已修剪，这里直接关）
    if (!get().status?.unmerged.some((f) => f.path === path)) set({ conflictView: null });
  },

  markResolvedFlow: async (path) => {
    const doResolve = () =>
      runWrite(set, get, `标记已解决 ${path}…`, `已标记 ${path} 已解决`, async () => {
        await ipc.stage([path]);
      });
    // 仍有冲突标记时先警示（可能没改完）——用与视图一致的权威解析器
    let result = get().conflictView?.path === path ? get().conflictView?.result : null;
    try {
      result = await ipc.readWorktreeFile(path);
    } catch {
      // 读不到（如已删除）不阻断标记
    }
    const parsed = result !== null && result !== undefined ? parseConflictBlocks(result) : null;
    if (parsed && (parsed.blocks.length > 0 || !parsed.wellFormed)) {
      get().openDialog({
        title: "文件仍含冲突标记",
        message: `${path} 里还有 <<<<<<< 标记，直接标记已解决会把冲突标记提交进版本库。确定要继续吗？`,
        actions: [
          { label: "仍要标记已解决", kind: "danger", run: () => void doResolve() },
        ],
      });
      return;
    }
    await doResolve();
    if (!get().status?.unmerged.some((f) => f.path === path)) set({ conflictView: null });
  },

  continueOperationFlow: async () => {
    const op = get().status?.operation;
    if (!op) return;
    if ((get().status?.unmerged.length ?? 0) > 0) {
      get().pushToast("err", "还有冲突文件未解决，无法继续");
      return;
    }
    const label = OPERATION_LABEL[op].cont;
    await runWrite(set, get, `${label}…`, `${label}完成`, async () => {
      await ipc.continueOperation(op);
    });
    set({ conflictView: null });
  },

  openConflictInEditor: async (path) => {
    try {
      await ipc.openInEditor(path);
    } catch (e) {
      get().pushToast("err", await errText(e));
    }
  },

  applyConflictBlock: async (path, blockIndex, side) => {
    if (get().writeBusy) {
      get().pushToast("err", "有操作正在进行中，请稍候");
      return;
    }
    // 以视图中的工作区结果为基准拼装，写回后同步刷新视图内容
    const base = get().conflictView?.path === path ? get().conflictView?.result : null;
    if (base === null || base === undefined) return;
    const next = applyBlockChoice(base, blockIndex, side);
    if (next === base) {
      get().pushToast("err", "冲突处理失败：标记结构异常或块已不存在");
      return;
    }
    try {
      // 写回工作区文件（不 add）；走后端守卫路径
      await ipc.writeWorktreeFile(path, next);
      if (get().conflictView?.path === path)
        set({ conflictView: { ...get().conflictView!, result: next } });
    } catch (e) {
      get().pushToast("err", await errText(e));
    }
  },

  cherryPickFlow: async (commitId) => {
    if (get().writeBusy) {
      get().pushToast("err", "有操作正在进行中，请稍候");
      return;
    }
    if (!(await ensureCleanTree(get))) return;
    const branch = get().summary?.branch ?? get().meta?.branch ?? "";
    get().openDialog({
      title: "摘取此提交",
      message: `把 ${commitId.slice(0, 7)} 的改动摘取到当前分支 ${branch}（git cherry-pick）。`,
      actions: [
        {
          label: "摘取",
          kind: "primary",
          run: () => {
            void (async () => {
              await runWrite(set, get, "摘取提交…", "已摘取该提交", async () => {
                await ipc.cherryPick(commitId);
              });
              // runWrite 的失败分支不刷新——先拉取最新状态再做语义分类
              await get().refresh();
              // 失败语义按仓库状态分类（不匹配 stderr 文案，locale 无关）：
              // 停在 cherry-pick 且无未合入文件 = 空提交；有未合入文件 = 冲突（横幅已接管）
              const st = get().status;
              if (st?.operation === "cherry-pick" && st.unmerged.length === 0) {
                get().openDialog({
                  title: "空提交",
                  message: "该提交的改动已经包含在当前分支里，应用它不会产生任何变化。",
                  actions: [
                    {
                      label: "跳过并继续",
                      run: () => {
                        void runWrite(set, get, "跳过空提交…", "已跳过空提交", async () => {
                          await ipc.cherryPickSkip();
                        });
                      },
                    },
                    {
                      label: "仍然提交（空提交）",
                      run: () => {
                        void runWrite(set, get, "提交空提交…", "已保留空提交", async () => {
                          await ipc.cherryPickKeep();
                        });
                      },
                    },
                    {
                      label: "放弃本次摘取",
                      kind: "danger",
                      run: () => {
                        void runWrite(set, get, "放弃摘取…", "已放弃本次摘取", async () => {
                          await ipc.abortOperation("cherry-pick");
                        });
                      },
                    },
                  ],
                });
              }
            })();
          },
        },
      ],
    });
  },

  revertFlow: async (commitId) => {
    if (get().writeBusy) {
      get().pushToast("err", "有操作正在进行中，请稍候");
      return;
    }
    // 合并提交需要 -m 主线，本版不支持（spec 决策）
    const commit = get().commits.find((c) => c.id === commitId);
    if (commit && commit.parents.length > 1) {
      get().openDialog({
        title: "无法还原合并提交",
        message:
          "这是合并提交：还原它需要指定保留哪条主线（git revert -m），暂不支持。可以先还原其单个父提交序列，或在终端处理。",
        actions: [],
      });
      return;
    }
    if (!(await ensureCleanTree(get))) return;
    const branch = get().summary?.branch ?? get().meta?.branch ?? "";
    get().openDialog({
      title: "还原此提交",
      message: `生成一个反向提交撤销 ${commitId.slice(0, 7)} 的改动，落在分支 ${branch} 上（git revert，不改写历史）。`,
      actions: [
        {
          label: "还原",
          kind: "primary",
          run: () => {
            void runWrite(set, get, "还原提交…", "已还原该提交", async () => {
              try {
                await ipc.revertCommit(commitId);
              } catch (e) {
                await get().refresh();
                if (get().status?.operation === "revert") {
                  get().pushToast("err", `还原产生冲突：${get().status?.unmerged.length ?? 0} 个冲突文件，点开冲突文件处理或中止。`);
                  return;
                }
                throw e;
              }
            });
          },
        },
      ],
    });
  },

  mergeBranchFlow: async (branch) => {
    if (get().writeBusy) {
      get().pushToast("err", "有操作正在进行中，请稍候");
      return;
    }
    const current = get().summary?.branch ?? get().meta?.branch ?? "";
    if (!current || branch === current) return;
    get().openDialog({
      title: "合并分支",
      message: `把 ${branch} 合并到当前分支 ${current}。产生冲突时会进入冲突解决流程。`,
      actions: [
        {
          label: `合并 ${branch}`,
          kind: "primary",
          run: () => {
            void runWrite(set, get, `合并 ${branch}…`, `已合并 ${branch} 到 ${current}`, async () => {
              try {
                await ipc.mergeRef(branch);
              } catch (e) {
                await get().refresh();
                if (get().status?.operation === "merge") {
                  get().pushToast(
                    "err",
                    `合并产生冲突：${get().status?.unmerged.length ?? 0} 个冲突文件，点开冲突文件处理或中止。`,
                  );
                  return;
                }
                throw e;
              }
            });
          },
        },
      ],
    });
  },

  discardWorktreeFlow: (files) => {
    if (files.length === 0) return;
    const names = files.map((f) => f.path);
    const batch = files.length > 1;
    const restore = files.filter((f) => f.status !== "A").map((f) => f.path);
    const untracked = files.filter((f) => f.status === "A").map((f) => f.path);
    get().openDialog({
      title: batch ? `丢弃 ${files.length} 个文件的改动？` : `丢弃 ${names[0]} 的改动？`,
      message: batch
        ? "所选文件将从暂存区内容恢复（未跟踪文件将被删除），均不可恢复。"
        : "该文件将从暂存区内容恢复，未暂存的改动不可恢复。",
      files: batch ? names : undefined,
      actions: [
        {
          label: batch ? `丢弃所选（${files.length} 个文件）` : "丢弃改动",
          kind: "danger",
          run: () => {
            void runWrite(set, get, "丢弃改动…", "已丢弃所选改动", async () => {
              if (restore.length) await ipc.discardWorktree(restore);
              if (untracked.length) await ipc.deleteUntracked(untracked);
            });
          },
        },
      ],
    });
  },

  discardStagedFlow: (files) => {
    if (files.length === 0) return;
    const names = files.map((f) => (f.old_path ? `${f.old_path} → ${f.path}` : f.path));
    const batch = files.length > 1;
    const restore = files
      .filter((f) => f.status !== "A")
      .flatMap((f) => (f.old_path ? [f.old_path, f.path] : [f.path]));
    const added = files.filter((f) => f.status === "A").map((f) => f.path);
    get().openDialog({
      title: batch ? `丢弃 ${files.length} 个文件的改动？` : `丢弃 ${names[0]} 的改动？`,
      message: batch
        ? "所选文件的已暂存改动会连同暂存状态一起消失，恢复到 HEAD（新增文件将从磁盘删除），均不可恢复。"
        : "已暂存的改动会连同暂存状态一起消失，文件恢复到 HEAD，不可恢复。",
      files: batch ? names : undefined,
      actions: [
        {
          label: batch ? `丢弃所选（${files.length} 个文件）` : "丢弃（含暂存状态）",
          kind: "danger",
          run: () => {
            void runWrite(set, get, "丢弃改动…", "已丢弃所选改动", async () => {
              if (restore.length) await ipc.discardStaged(restore);
              if (added.length) await ipc.discardStagedNew(added);
            });
          },
        },
      ],
    });
  },

  discardAllFlow: () => {
    const st = get().status;
    if (!st) return;
    const files = [...st.staged, ...st.unstaged].map((f) => f.path);
    get().openDialog({
      title: "全部丢弃？",
      message:
        "所有已暂存与未暂存的改动将退回 HEAD，未跟踪文件与目录一并删除，均不可恢复。建议先 stash 留个存档。",
      files,
      actions: [
        {
          label: `全部丢弃（${files.length} 个文件）`,
          kind: "danger",
          run: () => {
            void runWrite(set, get, "全部丢弃…", "已丢弃全部改动", async () => {
              await ipc.discardAll();
            });
          },
        },
      ],
    });
  },

  setFilter: (f) => set({ filter: f }),
}));

/** 按信息/作者子串过滤（spec 故事 11） */
export function filterCommits(
  commits: CommitEntry[],
  filter: string,
): CommitEntry[] {
  const f = filter.trim().toLowerCase();
  if (!f) return commits;
  return commits.filter(
    (c) =>
      c.subject.toLowerCase().includes(f) || c.author_name.toLowerCase().includes(f),
  );
}
