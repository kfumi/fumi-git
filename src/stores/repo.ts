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
  status: RepoStatus | null;
  summary: BranchSummary | null;
  filter: string;
  toasts: Toast[];

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
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<boolean>;
  remote: (op: "fetch" | "pull" | "push") => Promise<void>;
  setFilter: (f: string) => void;
  pushToast: (kind: Toast["kind"], text: string) => number;
  /** 就地改写某条提示（busy → ok/err 的转场复用同一条，不打断视线） */
  updateToast: (id: number, patch: Partial<Pick<Toast, "kind" | "text">>) => void;
  dismissToast: (id: number) => void;
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
  status: null,
  summary: null,
  filter: "",
  toasts: [],

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
