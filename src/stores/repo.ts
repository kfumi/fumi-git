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
      if (get().selectedId === id) {
        // 换提交后文件 tab 重置为第一个文件
        const first = detail.files[0]?.path ?? null;
        set({ detail, detailLoading: false, openFiles: first ? [first] : [], detailFile: first });
      }
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
