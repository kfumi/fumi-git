import { beforeEach, describe, expect, it, vi } from "vitest";
import { filterCommits, useRepo } from "./repo";
import type { CommitEntry } from "../lib/types";

// 打桩 IPC（spec 测试决策：前端 store 以打桩 IPC 测状态流转）
vi.mock("../lib/ipc", () => {
  const ipcMock = {
    getConfig: vi.fn(async () => ({ recent_repos: [], theme: "system" })),
    setTheme: vi.fn(async () => {}),
    removeRecent: vi.fn(async () => {}),
    pickDirectory: vi.fn(),
    openRepo: vi.fn(),
    getLog: vi.fn(),
    getCommitDetail: vi.fn(),
    getStatus: vi.fn(),
    getBranchSummary: vi.fn(),
    stage: vi.fn(async () => {}),
    unstage: vi.fn(async () => {}),
    commit: vi.fn(),
    fetch: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
  };
  return {
    ipc: ipcMock,
    asGitError: async (e: unknown) => e,
    listenRepoChanged: vi.fn(async () => async () => {}),
  };
});

const { ipc } = (await import("../lib/ipc")) as typeof import("../lib/ipc") & {
  ipc: Record<string, ReturnType<typeof vi.fn>>;
};

let seq = 0;
const c = (id: string, subject: string, author = "林一帆"): CommitEntry => ({
  id,
  short_id: id.slice(0, 7),
  parents: [],
  author_name: author,
  author_email: "a@b.c",
  time: seq++,
  subject,
  refs: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  useRepo.setState({
    config: { recent_repos: [], theme: "system" },
    meta: null,
    commits: [],
    logDone: false,
    loadingMore: false,
    selectedId: null,
    detail: null,
    detailLoading: false,
    status: null,
    summary: null,
    filter: "",
    toast: null,
  });
});

describe("filterCommits", () => {
  it("按信息与作者子串过滤，大小写不敏感", () => {
    const commits = [c("1", "feat: 图谱渲染"), c("2", "chore: 升级", "kevin"), c("3", "fix: lane", "Kevin")];
    expect(filterCommits(commits, "图谱").map((x) => x.id)).toEqual(["1"]);
    expect(filterCommits(commits, "kevin").map((x) => x.id)).toEqual(["2", "3"]);
    expect(filterCommits(commits, "").length).toBe(3);
  });
});

describe("store 状态流转（打桩 IPC）", () => {
  it("openRepo 成功：meta/commits/status/summary 就位，最近列表刷新", async () => {
    (ipc.openRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "demo", path: "D:/demo", branch: "main" });
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [c("a", "first")], done: true });
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ staged: [], unstaged: [], branch: "main" });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
    });

    const ok = await useRepo.getState().openRepo("D:/demo");
    expect(ok).toBe(true);
    const s = useRepo.getState();
    expect(s.meta?.name).toBe("demo");
    expect(s.commits.length).toBe(1);
    expect(s.status).not.toBeNull();
    expect(s.summary).not.toBeNull();
  });

  it("openRepo 失败：toast 结构化错误，仓库未打开", async () => {
    (ipc.openRepo as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "NotARepo",
      message: "不是 git 仓库",
    });
    const ok = await useRepo.getState().openRepo("D:/nope");
    expect(ok).toBe(false);
    expect(useRepo.getState().meta).toBeNull();
    expect(useRepo.getState().toast?.kind).toBe("err");
    expect(useRepo.getState().toast?.text).toContain("不是 git 仓库");
  });

  it("stage 后工作区状态即时刷新", async () => {
    (ipc.getStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ staged: [], unstaged: [{ path: "a.ts", old_path: null, status: "M" }], branch: "main" })
      .mockResolvedValueOnce({ staged: [{ path: "a.ts", old_path: null, status: "M" }], unstaged: [], branch: "main" });
    const store = useRepo.getState();
    useRepo.setState({ status: await ipc.getStatus() });
    await store.stage(["a.ts"]);
    expect(ipc.stage).toHaveBeenCalledWith(["a.ts"]);
    expect(useRepo.getState().status?.staged.length).toBe(1);
  });

  it("loadMore 几何增长：limit 随已加载数量扩大", async () => {
    (ipc.openRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "d", path: "D:/d", branch: "main" });
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: false });
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await useRepo.getState().openRepo("D:/d");
    useRepo.setState({ commits: [c("x", "x")], logDone: false });
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: false });
    await useRepo.getState().loadMore();
    const [, limit] = (ipc.getLog as ReturnType<typeof vi.fn>).mock.lastCall as [number, number];
    expect(limit).toBe(200); // 已加载 1 条 → max(200, 1/4) = 200
    useRepo.setState({ commits: Array.from({ length: 1000 }, (_, i) => c(`k${i}`, `k${i}`)) });
    await useRepo.getState().loadMore();
    const [, limit2] = (ipc.getLog as ReturnType<typeof vi.fn>).mock.lastCall as [number, number];
    expect(limit2).toBe(250); // max(200, 1000/4)
  });
});
