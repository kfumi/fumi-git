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
    getWorktreeDiff: vi.fn(),
    getBranchSummary: vi.fn(),
    stage: vi.fn(async () => {}),
    unstage: vi.fn(async () => {}),
    commit: vi.fn(),
    fetch: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    switchBranch: vi.fn(async () => {}),
    stashPush: vi.fn(async () => {}),
    createBranch: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    branchUnmergedCount: vi.fn(async () => 0),
    renameBranch: vi.fn(async () => {}),
    resetBranch: vi.fn(async () => {}),
    pushUpstream: vi.fn(async () => ""),
    listRemotes: vi.fn(async () => ["origin"]),
    mergeUpstream: vi.fn(async () => ""),
    abortMerge: vi.fn(async () => {}),
    stashList: vi.fn(async () => []),
    stashDiff: vi.fn(async () => ""),
    stashApply: vi.fn(async () => {}),
    stashDrop: vi.fn(async () => {}),
    discardWorktree: vi.fn(async () => {}),
    deleteUntracked: vi.fn(async () => {}),
    discardStaged: vi.fn(async () => {}),
    discardStagedNew: vi.fn(async () => {}),
    discardAll: vi.fn(async () => {}),
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
    openFiles: [],
    detailFile: null,
    status: null,
    summary: null,
    filter: "",
    toasts: [],
    dialog: null,
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
    const toasts = useRepo.getState().toasts;
    const toast = toasts[toasts.length - 1];
    expect(toast?.kind).toBe("err");
    expect(toast?.text).toContain("不是 git 仓库");
  });

  it("remote：busy 提示就地转场为结果（成功 ok / 失败 err）", async () => {
    useRepo.setState({
      meta: { name: "demo", path: "D:/demo", branch: "main" },
      commits: [],
      logDone: true,
    });
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.pull as ReturnType<typeof vi.fn>).mockResolvedValue("已拉取 origin/main");
    (ipc.push as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "CommandFailed",
      message: "没有配置上游",
    });

    await useRepo.getState().remote("pull");
    let s = useRepo.getState();
    expect(s.toasts).toHaveLength(1); // busy 被原地改写，不叠加
    expect(s.toasts[0].kind).toBe("ok");
    expect(s.toasts[0].text).toBe("已拉取 origin/main");

    await useRepo.getState().remote("push");
    s = useRepo.getState();
    expect(s.toasts).toHaveLength(2);
    expect(s.toasts[1].kind).toBe("err");
    expect(s.toasts[1].text).toContain("没有配置上游");

    useRepo.getState().dismissToast(s.toasts[1].id);
    expect(useRepo.getState().toasts).toHaveLength(1);
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

describe("提交详情文件 tab", () => {
  it("select 成功后 tab 清空（点文件才展开）；openDetailFile 打开/去重/激活", async () => {
    useRepo.setState({
      meta: { name: "demo", path: "D:/demo", branch: "main" },
      openFiles: ["src/old.ts"],
      detailFile: "src/old.ts",
    });
    (ipc.getCommitDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      meta: { id: "a", short_id: "a", subject: "s", author_name: "林", author_email: "a@b.c", time: 1, parents: [], refs: [] },
      files: [
        { path: "src/a.ts", old_path: null, status: "M", add: 1, del: 0, binary: false },
        { path: "src/b.ts", old_path: null, status: "A", add: 2, del: 0, binary: false },
      ],
      patch: "",
    });

    await useRepo.getState().select("a");
    let s = useRepo.getState();
    expect(s.openFiles).toEqual([]); // 默认不展示 diff 面板
    expect(s.detailFile).toBeNull();

    useRepo.getState().openDetailFile("src/a.ts");
    useRepo.getState().openDetailFile("src/b.ts");
    s = useRepo.getState();
    expect(s.openFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(s.detailFile).toBe("src/b.ts");

    useRepo.getState().openDetailFile("src/a.ts"); // 已打开 → 仅激活，不重复
    s = useRepo.getState();
    expect(s.openFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(s.detailFile).toBe("src/a.ts");

    await useRepo.getState().select(null);
    s = useRepo.getState();
    expect(s.openFiles).toEqual([]);
    expect(s.detailFile).toBeNull();
  });

  it("closeDetailFile：关闭激活 tab 时激活相邻，全部关闭后为空", () => {
    useRepo.setState({ openFiles: ["a.ts", "b.ts", "c.ts"], detailFile: "b.ts" });
    useRepo.getState().closeDetailFile("b.ts");
    expect(useRepo.getState().detailFile).toBe("c.ts");

    useRepo.setState({ openFiles: ["a.ts", "c.ts"], detailFile: "c.ts" });
    useRepo.getState().closeDetailFile("c.ts");
    expect(useRepo.getState().detailFile).toBe("a.ts");

    useRepo.getState().closeDetailFile("a.ts");
    expect(useRepo.getState().openFiles).toEqual([]);
    expect(useRepo.getState().detailFile).toBeNull();
  });
});

describe("工作区文件 diff", () => {
  it("selectWorkFile 拉取 patch；再点同文件收起；点 null 直接收起", async () => {
    (ipc.getWorktreeDiff as ReturnType<typeof vi.fn>).mockResolvedValue("+line3\n");
    await useRepo.getState().selectWorkFile("a.ts", false);
    let s = useRepo.getState();
    expect(s.workFile).toBe("a.ts");
    expect(s.workStaged).toBe(false);
    expect(s.workDiff).toBe("+line3\n");
    expect(ipc.getWorktreeDiff).toHaveBeenCalledWith(false, "a.ts");

    await useRepo.getState().selectWorkFile("a.ts", false); // 同文件 → 收起
    s = useRepo.getState();
    expect(s.workFile).toBeNull();
    expect(s.workDiff).toBeNull();

    await useRepo.getState().selectWorkFile("a.ts", true); // 已暂存版本
    expect(ipc.getWorktreeDiff).toHaveBeenLastCalledWith(true, "a.ts");

    await useRepo.getState().selectWorkFile(null);
    expect(useRepo.getState().workFile).toBeNull();
  });

  it("refresh 后选中文件已不在工作区 → 自动收起；仍在则刷新 diff", async () => {
    useRepo.setState({
      meta: { name: "demo", path: "D:/demo", branch: "main" },
      commits: [c("a", "first")],
      logDone: true,
      workFile: "gone.ts",
      workStaged: false,
      workDiff: "old",
    });
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [c("a", "first")], done: true });
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [{ path: "a.ts", old_path: null, status: "M" }],
      branch: "main",
    });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (ipc.getWorktreeDiff as ReturnType<typeof vi.fn>).mockResolvedValue("+line3\n");

    await useRepo.getState().refresh();
    expect(useRepo.getState().workFile).toBeNull(); // gone.ts 已消失

    await useRepo.getState().selectWorkFile("a.ts", false);
    (ipc.getWorktreeDiff as ReturnType<typeof vi.fn>).mockResolvedValue("+fresh\n");
    await useRepo.getState().refresh();
    expect(useRepo.getState().workFile).toBe("a.ts"); // 仍在 → diff 刷新
    expect(useRepo.getState().workDiff).toBe("+fresh\n");
  });
});

describe("checkout 安全模型（票 01）", () => {
  const clean = { staged: [], unstaged: [], branch: "main" };
  const dirty = {
    staged: [{ path: "s.ts", old_path: null, status: "M" as const }],
    unstaged: [{ path: "u.ts", old_path: null, status: "M" as const }],
    branch: "main",
  };

  it("干净工作树：直接迁出并刷新", async () => {
    useRepo.setState({ meta: { name: "demo", path: "D:/demo", branch: "main" } });
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(clean);
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await useRepo.getState().checkout("feat");
    expect(ipc.switchBranch).toHaveBeenCalledWith("feat");
    expect(useRepo.getState().dialog).toBeNull();
    expect(useRepo.getState().toasts[0]).toMatchObject({ kind: "ok", text: "已迁出到 feat" });
  });

  it("脏工作树：拦截弹三选，不直接迁出", async () => {
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(dirty);

    await useRepo.getState().checkout("feat");
    expect(ipc.switchBranch).not.toHaveBeenCalled();
    const d = useRepo.getState().dialog;
    expect(d).not.toBeNull();
    expect(d?.files).toEqual(["s.ts", "u.ts"]);
    expect(d?.actions.map((a) => a.label)).toEqual(["带着改动迁出", "stash 后迁出"]);

    d!.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.switchBranch).toHaveBeenCalledWith("feat"));
  });

  it("脏工作树选「stash 后迁出」：先入 stash 再迁出", async () => {
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(dirty);
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await useRepo.getState().checkout("feat");
    const d = useRepo.getState().dialog!;
    // 宿主契约：action.run 返回非 false 时由 DialogHost 关闭对话框
    if (d.actions[1].run("", false) !== false) useRepo.getState().closeDialog();
    await vi.waitFor(() => expect(ipc.switchBranch).toHaveBeenCalledWith("feat"));
    expect(ipc.stashPush).toHaveBeenCalledWith("迁出前自动暂存");
    expect(useRepo.getState().dialog).toBeNull();
  });
});

describe("分支生命周期（票 02）", () => {
  const withRepo = () =>
    useRepo.setState({ meta: { name: "demo", path: "D:/demo", branch: "main" } });
  const logOk = () => {
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  };

  it("createBranch：空名返回错误不发起 IPC；成功后提示并刷新", async () => {
    withRepo();
    logOk();
    expect(await useRepo.getState().createBranch("  ", true)).toContain("不能为空");
    expect(ipc.createBranch).not.toHaveBeenCalled();

    await useRepo.getState().createBranch("feat", true);
    expect(ipc.createBranch).toHaveBeenCalledWith("feat", true, undefined);
    expect(useRepo.getState().toasts[0]).toMatchObject({ kind: "ok" });
  });

  it("createBranch：后端校验错误原样返回给对话框", async () => {
    (ipc.createBranch as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "CommandFailed",
      message: "分支 feat 已存在",
    });
    expect(await useRepo.getState().createBranch("feat", false)).toContain("已存在");
  });

  it("deleteBranchFlow：未合入 → 展示计数后二次强删确认；已合入 → 一次确认", async () => {
    withRepo();
    (ipc.branchUnmergedCount as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    await useRepo.getState().deleteBranchFlow("feat");
    // 第一步：展示未合入计数
    let d = useRepo.getState().dialog!;
    expect(d.message).toContain("3 个提交未合入");
    expect(d.actions[0].label).toBe("继续");
    d.actions[0].run("", false);
    // 第二步：强制删除确认（spec 决策 #5 双保险）
    d = useRepo.getState().dialog!;
    expect(d.title).toBe("确认强制删除");
    expect(d.actions[0].label).toContain("强制删除");
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.deleteBranch).toHaveBeenCalledWith("feat", true));
    await vi.waitFor(() => expect(useRepo.getState().writeBusy).toBe(false));

    (ipc.branchUnmergedCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    await useRepo.getState().deleteBranchFlow("temp");
    d = useRepo.getState().dialog!;
    expect(d.actions[0].label).toBe("删除分支");
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.deleteBranch).toHaveBeenLastCalledWith("temp", false));
  });

  it("renameBranchFlow：预填原名，同名保持打开，成功后刷新", async () => {
    withRepo();
    logOk();
    useRepo.getState().renameBranchFlow("feat");
    let d = useRepo.getState().dialog!;
    expect(d.input?.initial).toBe("feat");
    expect(await d.actions[0].run("feat", false)).toBe(false); // 同名 → 保持打开
    expect(await d.actions[0].run("feat2", false)).toBeUndefined();
    expect(ipc.renameBranch).toHaveBeenCalledWith("feat", "feat2");
  });
});

describe("图谱提交右键：建分支与 reset（票 03）", () => {
  const withRepo = () =>
    useRepo.setState({
      meta: { name: "demo", path: "D:/demo", branch: "main" },
      summary: { branch: "main", upstream: null, ahead: 0, behind: 0 },
    });
  const logOk = () => {
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  };

  it("createBranch 传入起点提交，透传给 IPC", async () => {
    withRepo();
    logOk();
    await useRepo.getState().createBranch("feat", true, "abc123");
    expect(ipc.createBranch).toHaveBeenCalledWith("feat", true, "abc123");
  });

  it("resetBranchTo：先弹模式选择；硬重置遇脏树再拦截", async () => {
    withRepo();
    logOk();
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [{ path: "a.ts", old_path: null, status: "M" }],
      branch: "main",
    });

    useRepo.getState().resetBranchTo("abc123def");
    let d = useRepo.getState().dialog!;
    expect(d.title).toBe("重置当前分支到此提交");
    expect(d.actions).toHaveLength(3);

    // 软重置直接执行
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.resetBranch).toHaveBeenCalledWith("abc123def", "soft"));

    // 硬重置：脏树 → 二次拦截对话框
    useRepo.getState().resetBranchTo("abc123def");
    d = useRepo.getState().dialog!;
    d.actions[2].run("", false);
    await vi.waitFor(() => expect(useRepo.getState().dialog!.files).toEqual(["a.ts"]));
    expect(ipc.resetBranch).not.toHaveBeenCalledWith("abc123def", "hard");

    // 确认丢弃后才真正硬重置
    useRepo.getState().dialog!.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.resetBranch).toHaveBeenCalledWith("abc123def", "hard"));
  });

  it("resetBranchTo：干净树硬重置不拦截", async () => {
    withRepo();
    logOk();
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [],
      branch: "main",
    });

    useRepo.getState().resetBranchTo("abc123def");
    const d = useRepo.getState().dialog!;
    d.actions[2].run("", false);
    await vi.waitFor(() => expect(ipc.resetBranch).toHaveBeenCalledWith("abc123def", "hard"));
  });
});

describe("远程同步补全（票 04）", () => {
  const withRepo = () =>
    useRepo.setState({
      meta: { name: "demo", path: "D:/demo", branch: "feat" },
      summary: { branch: "feat", upstream: "origin/feat", ahead: 1, behind: 1 },
    });
  const logOk = () => {
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  };

  it("push 无上游：弹远程选择框，单远程锁定 origin，确认后 push -u", async () => {
    withRepo();
    logOk();
    (ipc.listRemotes as ReturnType<typeof vi.fn>).mockResolvedValue(["origin"]);
    (ipc.push as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "NoUpstream",
      message: "分支 feat 还没有上游",
    });

    await useRepo.getState().remote("push");
    const d = useRepo.getState().dialog!;
    expect(d.title).toBe("推送并建立上游关联");
    expect(d.actions).toHaveLength(1); // 单远程 → 只有一个目标
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.pushUpstream).toHaveBeenCalledWith("origin", "feat"));
  });

  it("pull 分叉：报错转为合并确认，确认后执行 merge", async () => {
    withRepo();
    logOk();
    (ipc.pull as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "NonFastForward",
      message: "本地与远程历史分叉",
    });
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [],
      unmerged: [],
      merging: false,
      branch: "feat",
    });

    await useRepo.getState().remote("pull");
    const d = useRepo.getState().dialog!;
    expect(d.title).toBe("本地与远程分叉");
    expect(d.message).toContain("origin/feat");
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.mergeUpstream).toHaveBeenCalledWith("origin/feat"));
  });

  it("merge 冲突：刷新后处于合并中 → 错误提示带冲突文件数", async () => {
    withRepo();
    logOk();
    (ipc.mergeUpstream as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "CommandFailed",
      message: "CONFLICT (content): Merge conflict in a.txt",
    });
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [],
      unmerged: [{ path: "a.txt", old_path: null, status: "U" }],
      merging: true,
      branch: "feat",
    });

    await useRepo.getState().mergeUpstreamFlow("origin/feat");
    const d = useRepo.getState().dialog!;
    d.actions[0].run("", false);
    await vi.waitFor(() => {
      const t = useRepo.getState().toasts[0];
      expect(t.text).toContain("1 个冲突文件");
    });
  });

  it("abortMerge：成功后提示并刷新", async () => {
    withRepo();
    logOk();
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [],
      unmerged: [],
      merging: false,
      branch: "feat",
    });
    await useRepo.getState().abortMerge();
    expect(ipc.abortMerge).toHaveBeenCalled();
    expect(useRepo.getState().toasts[0]).toMatchObject({ kind: "ok" });
  });
});

describe("stash 管理（票 05）", () => {
  const withRepo = () =>
    useRepo.setState({
      meta: { name: "demo", path: "D:/demo", branch: "main" },
      stashes: [
        { index: 0, message: "On main: wip2", time: 1700000002 },
        { index: 1, message: "On main: 第一条", time: 1700000001 },
      ],
    });
  const logOk = () => {
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [],
      unmerged: [],
      merging: false,
      branch: "main",
    });
  };

  it("refresh 拉取 stash 列表；查看中条目消失后自动收起", async () => {
    withRepo();
    logOk();
    (ipc.stashList as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ index: 0, message: "wip", time: 1 }])
      .mockResolvedValueOnce([]);
    (ipc.stashDiff as ReturnType<typeof vi.fn>).mockResolvedValue("+x");

    await useRepo.getState().selectStash(0);
    expect(useRepo.getState().stashView).toMatchObject({ index: 0, patch: "+x" });
    // 第一次 refresh：条目仍在（新列表覆盖 stashes）→ 查看保持
    await useRepo.getState().refresh();
    expect(useRepo.getState().stashView).toMatchObject({ index: 0 });
    // 第二次 refresh：条目消失 → 自动收起
    await useRepo.getState().refresh();
    expect(useRepo.getState().stashView).toBeNull();
  });

  it("selectStash：再次点击收起；diff 拉取传 index", async () => {
    withRepo();
    (ipc.stashDiff as ReturnType<typeof vi.fn>).mockResolvedValue("+x");
    await useRepo.getState().selectStash(1);
    expect(ipc.stashDiff).toHaveBeenCalledWith(1);
    await useRepo.getState().selectStash(1);
    expect(useRepo.getState().stashView).toBeNull();
  });

  it("stashRestore：apply 保留副本 / pop 成功移除；pop 冲突提示条目保留", async () => {
    withRepo();
    logOk();
    await useRepo.getState().stashRestore(1, false);
    expect(ipc.stashApply).toHaveBeenLastCalledWith(1, false);
    const toasts1 = useRepo.getState().toasts;
    expect(toasts1[toasts1.length - 1]).toMatchObject({ kind: "ok" });

    (ipc.stashApply as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "CommandFailed",
      message: "error: Your local changes would be overwritten",
    });
    (ipc.stashList as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 0, message: "wip", time: 1 },
    ]);
    await useRepo.getState().stashRestore(0, true);
    const toasts2 = useRepo.getState().toasts;
    const t = toasts2[toasts2.length - 1]!;
    expect(t.kind).toBe("err");
    expect(t.text).toContain("已保留");
  });

  it("stashDropFlow：确认后删除", async () => {
    withRepo();
    logOk();
    useRepo.getState().stashDropFlow(0);
    const d = useRepo.getState().dialog!;
    expect(d.actions[0].kind).toBe("danger");
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.stashDrop).toHaveBeenCalledWith(0));
  });
});

describe("丢弃改动（spec US22–25）", () => {
  const withRepo = () =>
    useRepo.setState({ meta: { name: "demo", path: "D:/demo", branch: "main" } });
  const logOk = () => {
    (ipc.getLog as ReturnType<typeof vi.fn>).mockResolvedValue({ commits: [], done: true });
    (ipc.getBranchSummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [],
      unmerged: [],
      merging: false,
      branch: "main",
    });
  };

  const fe = (path: string, status: "M" | "A" | "D" | "R", old_path: string | null = null) => ({
    path,
    old_path,
    status,
  });

  it("丢弃（批量）：未暂存 M/D → restore，未跟踪 → 删除；单文件不带清单", async () => {
    withRepo();
    logOk();
    useRepo.getState().discardWorktreeFlow([fe("a.ts", "M")]);
    let d = useRepo.getState().dialog!;
    expect(d.actions[0].kind).toBe("danger");
    expect(d.files).toBeUndefined(); // 单文件不展示文件清单
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.discardWorktree).toHaveBeenCalledWith(["a.ts"]));
    await vi.waitFor(() => expect(useRepo.getState().writeBusy).toBe(false));

    // 混合批量：M 走 restore、未跟踪走删除，一次确认
    useRepo.getState().discardWorktreeFlow([fe("u.ts", "M"), fe("n.ts", "A"), fe("v.ts", "D")]);
    d = useRepo.getState().dialog!;
    expect(d.files).toEqual(["u.ts", "n.ts", "v.ts"]);
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.deleteUntracked).toHaveBeenCalledWith(["n.ts"]));
    expect(ipc.discardWorktree).toHaveBeenLastCalledWith(["u.ts", "v.ts"]);
  });

  it("丢弃（批量）：已暂存 M/R 附 old_path；新增走 rm", async () => {
    withRepo();
    logOk();
    useRepo.getState().discardStagedFlow([
      fe("renamed.txt", "R", "old.txt"),
      fe("s.ts", "M"),
      fe("new.ts", "A"),
    ]);
    const d = useRepo.getState().dialog!;
    expect(d.files).toEqual(["old.txt → renamed.txt", "s.ts", "new.ts"]);
    d.actions[0].run("", false);
    await vi.waitFor(() =>
      expect(ipc.discardStaged).toHaveBeenCalledWith(["old.txt", "renamed.txt", "s.ts"]),
    );
    expect(ipc.discardStagedNew).toHaveBeenCalledWith(["new.ts"]);
  });

  it("全部丢弃：列出受影响文件；确认后 discardAll", async () => {
    withRepo();
    logOk();
    useRepo.setState({
      status: {
        staged: [{ path: "s.ts", old_path: null, status: "M" }],
        unstaged: [
          { path: "u.ts", old_path: null, status: "M" },
          { path: "n.ts", old_path: null, status: "A" },
        ],
        unmerged: [],
        merging: false,
        branch: "main",
      },
    });
    useRepo.getState().discardAllFlow();
    const d = useRepo.getState().dialog!;
    expect(d.files).toEqual(["s.ts", "u.ts", "n.ts"]);
    expect(d.actions[0].kind).toBe("danger");
    d.actions[0].run("", false);
    await vi.waitFor(() => expect(ipc.discardAll).toHaveBeenCalled());
  });

  it("writeBusy 期间拒绝第二个写操作（US31）", async () => {
    withRepo();
    logOk();
    // 手动置忙，模拟在飞操作
    useRepo.setState({ writeBusy: true });
    await useRepo.getState().checkout("feat");
    expect(ipc.switchBranch).not.toHaveBeenCalled();
    useRepo.setState({ writeBusy: false });
    (ipc.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      staged: [],
      unstaged: [],
      unmerged: [],
      merging: false,
      branch: "main",
    });
    await useRepo.getState().checkout("feat");
    expect(ipc.switchBranch).toHaveBeenCalledWith("feat");
  });
});

describe("侧栏引用跳转与右栏关闭", () => {
  it("selectRefTip：记录跳转信号（nonce 递增）并选中提交", async () => {
    useRepo.setState({
      meta: { name: "demo", path: "D:/demo", branch: "main" },
      mainTab: "changes", // 处于改动 tab 时点引用 → 自动切回历史
      scrollToId: null,
      scrollNonce: 0,
    });
    (ipc.getCommitDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      meta: { id: "tip1", short_id: "tip1", subject: "s", author_name: "林", author_email: "a@b.c", time: 1, parents: [], refs: [] },
      files: [],
      patch: "",
    });

    useRepo.getState().selectRefTip("tip1");
    const s = useRepo.getState();
    expect(s.mainTab).toBe("history");
    expect(s.scrollToId).toBe("tip1");
    expect(s.scrollNonce).toBe(1);
    await vi.waitFor(() => expect(useRepo.getState().selectedId).toBe("tip1"));

    useRepo.getState().selectRefTip("tip1"); // 同一引用再点 → nonce 仍递增，重复跳转生效
    expect(useRepo.getState().scrollNonce).toBe(2);
  });

  it("closeRightPane：改动 tab 收起工作文件 diff，历史 tab 取消选中提交", async () => {
    useRepo.setState({ mainTab: "changes", workFile: "a.ts", workStaged: false, workDiff: "+x" });
    await useRepo.getState().closeRightPane();
    expect(useRepo.getState().workFile).toBeNull();

    useRepo.setState({
      mainTab: "history",
      selectedId: "a",
      detail: { meta: { id: "a" } } as never,
      openFiles: ["a.ts"],
      detailFile: "a.ts",
    });
    useRepo.getState().closeRightPane();
    const s = useRepo.getState();
    expect(s.selectedId).toBeNull();
    expect(s.detail).toBeNull();
    expect(s.openFiles).toEqual([]);
    expect(s.detailFile).toBeNull();
  });
});
