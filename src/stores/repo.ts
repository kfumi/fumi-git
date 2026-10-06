// 主 store：仓库、提交日志、选中、详情、工作区、同步动作。
// IPC 返回视为类型化契约（见 docs/agents 域规则），本模块是前端唯一业务状态源。
import { create } from "zustand";
import { asGitError, ipc } from "../lib/ipc";
import type {
  AppConfig,
  BranchSummary,
  CommitDetail,
  CommitEntry,
  RepoMeta,
  RepoStatus,
} from "../lib/types";

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
  input?: { initial?: string; placeholder?: string };
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
  createBranch: (name: string, checkoutAfter: boolean) => Promise<string | void>;
  /** 新建分支对话框入口（基于当前 HEAD） */
  createBranchFlow: () => void;
  /** 删除分支入口：先取未合入计数，按结果弹一次确认或强制删除确认 */
  deleteBranchFlow: (branch: string) => Promise<void>;
  /** 分支改名（对话框表单，预填原名） */
  renameBranchFlow: (branch: string) => void;
}

const errText = async (e: unknown): Promise<string> =>
  `操作失败：${(await asGitError(e)).message}`;

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

  openDialog: (desc) => set({ dialog: desc }),
  closeDialog: () => set({ dialog: null }),

  checkout: async (branch) => {
    const st = await ipc.getStatus().catch(() => null);
    const dirtyFiles = st ? [...st.staged, ...st.unstaged].map((f) => f.path) : [];
    const doSwitch = async () => {
      const id = get().pushToast("busy", `迁出到 ${branch}…`);
      try {
        await ipc.switchBranch(branch);
        get().updateToast(id, { kind: "ok", text: `已迁出到 ${branch}` });
        await get().refresh();
      } catch (e) {
        get().updateToast(id, { kind: "err", text: await errText(e) });
      }
    };
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

  createBranch: async (name, checkoutAfter) => {
    const trimmed = name.trim();
    if (!trimmed) return "分支名不能为空";
    try {
      await ipc.createBranch(trimmed, checkoutAfter);
      get().pushToast(
        "ok",
        checkoutAfter ? `已创建并迁出到 ${trimmed}` : `已创建分支 ${trimmed}`,
      );
      await get().refresh();
    } catch (e) {
      return (await asGitError(e)).message;
    }
  },

  createBranchFlow: () => {
    get().openDialog({
      title: "新建分支",
      message: "基于当前 HEAD 创建新分支。",
      input: { placeholder: "分支名，如 feat/login" },
      checkbox: { label: "创建后立即迁出", initial: true },
      actions: [
        {
          label: "创建",
          kind: "primary",
          run: (name, checkoutAfter) => get().createBranch(name, checkoutAfter),
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
    get().openDialog({
      title: `删除分支 ${branch}`,
      message:
        unmerged > 0
          ? `该分支有 ${unmerged} 个提交未合入当前分支。强制删除后，这些提交将只存在于 reflog 中，很难找回。`
          : "该分支已全部合入当前分支。删除后分支引用不可恢复。",
      actions: [
        {
          label: unmerged > 0 ? `强制删除（丢弃 ${unmerged} 个提交）` : "删除分支",
          kind: "danger",
          run: () => {
            void (async () => {
              const id = get().pushToast("busy", `删除分支 ${branch}…`);
              try {
                await ipc.deleteBranch(branch, unmerged > 0);
                get().updateToast(id, { kind: "ok", text: `已删除分支 ${branch}` });
                await get().refresh();
              } catch (e) {
                get().updateToast(id, { kind: "err", text: await errText(e) });
              }
            })();
          },
        },
      ],
    });
  },

  renameBranchFlow: (branch) => {
    get().openDialog({
      title: "重命名分支",
      input: { initial: branch },
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
      const [page, status, summary] = await Promise.all([
        ipc.getLog(0, Math.max(PAGE, get().commits.length || PAGE)),
        ipc.getStatus().catch(() => null),
        ipc.getBranchSummary().catch(() => null),
      ]);
      const stillThere = selectedId && page.commits.some((c) => c.id === selectedId);
      set({
        commits: page.commits,
        logDone: page.done,
        status,
        summary,
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
      get().updateToast(id, { kind: "err", text: await errText(e) });
    }
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
