import { describe, expect, it, vi } from "vitest";
import type { MenuAction, MenuItem } from "../components/ContextMenu";
import {
  branchMenu,
  DETACHED_HINT,
  detachedHead,
  commitMenu,
  remoteMenu,
  type BranchTarget,
  type CommitTarget,
  type MenuActions,
  type RemoteTarget,
} from "./menus";

/** 全部动作齐备的包（后续工单接入的动作也一并给上，用于断言「接上之后菜单长什么样」） */
function fullActions() {
  return {
    checkout: vi.fn(),
    mergeBranch: vi.fn(),
    createBranchFrom: vi.fn(),
    copy: vi.fn(),
    showDetail: vi.fn(),
    copyCommitMessage: vi.fn(),
    cherryPick: vi.fn(),
    revert: vi.fn(),
    resetTo: vi.fn(),
    renameBranch: vi.fn(),
    deleteBranch: vi.fn(),
    checkoutRemote: vi.fn(),
    pushToRemote: vi.fn(),
    fetch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    setUpstream: vi.fn(),
    unsetUpstream: vi.fn(),
    pushBranch: vi.fn(),
    fetchForBranch: vi.fn(),
    createTag: vi.fn(),
    checkoutCommit: vi.fn(),
    rebaseOnto: vi.fn(),
    compareWithHead: vi.fn(),
    amendMessage: vi.fn(),
  } satisfies MenuActions;
}

/** 本票（02）真实铺给组件的那部分动作：后续工单的能力缺席 */
function baseActions() {
  const a = fullActions();
  return {
    checkout: a.checkout,
    mergeBranch: a.mergeBranch,
    createBranchFrom: a.createBranchFrom,
    copy: a.copy,
    showDetail: a.showDetail,
    copyCommitMessage: a.copyCommitMessage,
    cherryPick: a.cherryPick,
    revert: a.revert,
    resetTo: a.resetTo,
    renameBranch: a.renameBranch,
    deleteBranch: a.deleteBranch,
  } as MenuActions;
}

const trace = (items: MenuItem[]) => items.map((i) => (i.kind === "separator" ? "──" : i.label));

function itemOf(items: MenuItem[], label: string): MenuAction {
  for (const i of items) {
    // header（分组标题行，本地线 2026-10-24 加的类型）与 separator 都不是可点条目
    if (i.kind !== "separator" && i.kind !== "header" && i.label === label) return i;
  }
  throw new Error(`菜单里没有「${label}」项`);
}

const branch = (over: Partial<BranchTarget> = {}): BranchTarget => ({
  name: "feat/login",
  current: false,
  detached: false,
  ...over,
});

const remote = (over: Partial<RemoteTarget> = {}): RemoteTarget => ({
  remote: "origin",
  branch: "feat/login",
  full: "origin/feat/login",
  hasLocal: false,
  detached: false,
  ...over,
});

const commit = (over: Partial<CommitTarget> = {}): CommitTarget => ({
  id: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  short: "a1b2c3d",
  branches: [],
  isHead: false,
  currentBranch: "main",
  detached: false,
  ...over,
});

describe("branchMenu（本地分支）", () => {
  it("02 阶段：只出现本票能力支撑的项，不留占位项", () => {
    expect(trace(branchMenu(branch(), baseActions()))).toEqual([
      "检出",
      "从此处新建分支…",
      "合并到当前分支…",
      "──",
      "重命名…",
      "删除…",
      "──",
      "复制分支名",
    ]);
  });

  it("后续工单接入后：变基 / 上游 / 推送 / 抓取各就各位", () => {
    expect(trace(branchMenu(branch(), fullActions()))).toEqual([
      "检出",
      "从此处新建分支…",
      "合并到当前分支…",
      "将当前分支变基到此分支…",
      "──",
      "重命名…",
      "设置上游分支…",
      "取消上游关联",
      "删除…",
      "──",
      "复制分支名",
      "推送",
      "抓取",
    ]);
  });

  it("当前分支：检出与删除禁用并给出原因，破坏性项沉底", () => {
    const items = branchMenu(branch({ current: true }), baseActions());
    expect(itemOf(items, "检出")).toMatchObject({ disabled: true, hint: "当前分支" });
    expect(itemOf(items, "合并到当前分支…")).toMatchObject({ disabled: true, hint: "当前分支" });
    const del = itemOf(items, "删除…");
    expect(del).toMatchObject({ disabled: true, danger: true, hint: "当前分支" });
    const afterDelete = trace(items)
      .slice(trace(items).indexOf("删除…") + 1)
      .filter((l) => l !== "──");
    expect(afterDelete).toEqual(["复制分支名"]);
  });

  it("「从此处新建分支…」以该分支为起点（不是 HEAD），并带出对话框文案", () => {
    const a = fullActions();
    const list = branchMenu(branch({ name: "fix/typo" }), a);
    itemOf(list, "从此处新建分支…").onSelect?.();
    expect(a.createBranchFrom).toHaveBeenCalledWith("fix/typo", "分支 fix/typo");
  });

  it("复制分支名把裸分支名交给剪贴板", () => {
    const a = fullActions();
    itemOf(branchMenu(branch({ name: "feat/x" }), a), "复制分支名").onSelect?.();
    expect(a.copy).toHaveBeenCalledWith("feat/x", "分支名");
  });

  it("上游：已有 upstream 时「设置上游分支…」禁用，缺失时「取消上游关联」禁用", () => {
    const withUp = branchMenu(branch({ upstream: "origin/feat/login" }), fullActions());
    expect(itemOf(withUp, "设置上游分支…")).toMatchObject({ disabled: true, hint: "已有 upstream" });
    expect(itemOf(withUp, "取消上游关联")).toMatchObject({ disabled: false });

    const withoutUp = branchMenu(branch({ upstream: null }), fullActions());
    expect(itemOf(withoutUp, "设置上游分支…").disabled).toBeFalsy();
    expect(itemOf(withoutUp, "取消上游关联").disabled).toBe(true);
  });
});

describe("remoteMenu（远程分支）", () => {
  it("02 阶段：只出现检出 / 新建分支 / 合并 / 复制分支名", () => {
    expect(trace(remoteMenu(remote(), baseActions()))).toEqual([
      "检出",
      "从此处新建分支…",
      "合并到当前分支…",
      "──",
      "复制分支名",
    ]);
  });

  it("03 接入后：删除远程分支单独成组（危险项），推送/抓取在末组", () => {
    expect(trace(remoteMenu(remote(), fullActions()))).toEqual([
      "检出",
      "从此处新建分支…",
      "合并到当前分支…",
      "将当前分支变基到此分支…",
      "──",
      "删除远程分支…",
      "──",
      "复制分支名",
      "推送",
      "抓取",
    ]);
    expect(itemOf(remoteMenu(remote(), fullActions()), "删除远程分支…").danger).toBe(true);
  });

  it("检出：本地已有同名分支时禁用并指向本地分支菜单；动作收到完整 ref", () => {
    const dup = remoteMenu(remote({ hasLocal: true }), fullActions());
    expect(itemOf(dup, "检出")).toMatchObject({ disabled: true, hint: "本地已有同名分支" });

    const a = fullActions();
    itemOf(remoteMenu(remote({ hasLocal: false }), a), "检出").onSelect?.();
    expect(a.checkoutRemote).toHaveBeenCalledWith("origin/feat/login", "feat/login");
  });

  it("推送：无同名本地分支时禁用；抓取只把远程名传下去", () => {
    const noLocal = remoteMenu(remote({ hasLocal: false }), fullActions());
    expect(itemOf(noLocal, "推送")).toMatchObject({ disabled: true, hint: "无同名本地分支" });

    const a = fullActions();
    const list = remoteMenu(remote({ hasLocal: true }), a);
    itemOf(list, "推送").onSelect?.();
    itemOf(list, "抓取").onSelect?.();
    itemOf(list, "复制分支名").onSelect?.();
    expect(a.pushToRemote).toHaveBeenCalledWith("origin", "feat/login");
    expect(a.fetch).toHaveBeenCalledWith("origin");
    expect(a.copy).toHaveBeenCalledWith("origin/feat/login", "分支名");
  });
});

describe("commitMenu（提交）", () => {
  it("02 阶段：显示差异 / 复制类 / 新建分支 / 拣选 / 反转 / 重置，无占位项", () => {
    expect(trace(commitMenu(commit(), baseActions()))).toEqual([
      "显示差异",
      "复制修订号",
      "复制提交信息",
      "──",
      "从此处新建分支…",
      "──",
      "拣选…",
      "反转提交…",
      "将当前分支重置到此处…",
    ]);
  });

  it("挂本地分支的提交：动态组排在最前，当前分支项禁用；不挂分支则无该组", () => {
    const list = commitMenu(
      commit({ branches: ["feat/a", "main"], currentBranch: "main" }),
      baseActions(),
    );
    expect(trace(list).slice(0, 5)).toEqual([
      "检出到 feat/a",
      "合并 feat/a 到当前分支…",
      "检出到 main",
      "──",
      "显示差异",
    ]);
    expect(itemOf(list, "检出到 main")).toMatchObject({ disabled: true, hint: "当前分支" });
    // 当前分支不出现「合并自己到自己」
    expect(trace(list)).not.toContain("合并 main 到当前分支…");

    expect(trace(commitMenu(commit({ branches: [] }), baseActions()))[0]).toBe("显示差异");
  });

  it("08 / 06 / 05 / 09 接入后：比较、检出该修订、新建标签、修改提交信息按序出现", () => {
    expect(trace(commitMenu(commit(), fullActions()))).toEqual([
      "显示差异",
      "复制修订号",
      "复制提交信息",
      "──",
      "与 HEAD 比较",
      "检出该修订…",
      "从此处新建分支…",
      "新建标签…",
      "──",
      "拣选…",
      "反转提交…",
      "将当前分支重置到此处…",
      "修改提交信息…",
    ]);
  });

  it("HEAD 提交：与 HEAD 比较和检出该修订禁用；修改提交信息仅 HEAD 可用", () => {
    const head = commitMenu(commit({ isHead: true }), fullActions());
    expect(itemOf(head, "与 HEAD 比较")).toMatchObject({ disabled: true, hint: "就是 HEAD" });
    expect(itemOf(head, "检出该修订…")).toMatchObject({ disabled: true, hint: "当前 HEAD" });
    expect(itemOf(head, "修改提交信息…").disabled).toBeFalsy();

    const old = commitMenu(commit({ isHead: false }), fullActions());
    expect(itemOf(old, "检出该修订…")).toMatchObject({ disabled: false, hint: "detached" });
    expect(itemOf(old, "修改提交信息…")).toMatchObject({ disabled: true, hint: "仅 HEAD" });
  });

  it("复制修订号给完整 hash（hint 才是短号）；复制提交信息走按需拉取", () => {
    const a = fullActions();
    const list = commitMenu(commit({ id: "abc123def456", short: "abc123d" }), a);
    expect(itemOf(list, "复制修订号").hint).toBe("abc123d");
    itemOf(list, "复制修订号").onSelect?.();
    itemOf(list, "复制提交信息").onSelect?.();
    expect(a.copy).toHaveBeenCalledWith("abc123def456", "修订号");
    expect(a.copyCommitMessage).toHaveBeenCalledWith("abc123def456");
  });

  it("「从此处新建分支…」以该提交为起点", () => {
    const a = fullActions();
    itemOf(commitMenu(commit({ id: "deadbeefcafe", short: "deadbee" }), a), "从此处新建分支…")
      .onSelect?.();
    expect(a.createBranchFrom).toHaveBeenCalledWith("deadbeefcafe", "提交 deadbee");
  });
});

describe("分离 HEAD 矩阵（ui-spec §4）", () => {
  it("detachedHead：解析后端 `(HEAD detached at <短号>)`；普通分支与无 summary 返回 null", () => {
    expect(detachedHead({ branch: "(HEAD detached at 1a2b3c4)" })).toEqual({ short: "1a2b3c4" });
    expect(detachedHead({ branch: "main" })).toBeNull();
    expect(detachedHead(null)).toBeNull();
  });

  it("本地分支菜单：同步与管理类全部禁用并统一提示，检出/新建分支/复制不受影响", () => {
    const items = branchMenu(
      branch({ detached: true, upstream: "origin/feat/login" }),
      fullActions(),
    );
    for (const label of [
      "合并到当前分支…",
      "将当前分支变基到此分支…",
      "重命名…",
      "设置上游分支…",
      "取消上游关联",
      "删除…",
      "推送",
      "抓取",
    ]) {
      expect(itemOf(items, label)).toMatchObject({ disabled: true, hint: DETACHED_HINT });
    }
    expect(itemOf(items, "检出").disabled).toBeFalsy();
    expect(itemOf(items, "从此处新建分支…").disabled).toBeFalsy();
    expect(itemOf(items, "复制分支名").disabled).toBeFalsy();
  });

  it("远程分支菜单：合并/变基/推送/抓取禁用并提示；检出与删除远程分支仍可用", () => {
    const items = remoteMenu(remote({ detached: true }), fullActions());
    for (const label of ["合并到当前分支…", "将当前分支变基到此分支…", "推送", "抓取"]) {
      expect(itemOf(items, label)).toMatchObject({ disabled: true, hint: DETACHED_HINT });
    }
    expect(itemOf(items, "检出").disabled).toBeFalsy();
    expect(itemOf(items, "删除远程分支…").disabled).toBeFalsy();
  });

  it("提交菜单：动态「合并 …」与「修改提交信息…」在分离 HEAD 下禁用并给提示", () => {
    const items = commitMenu(
      commit({ detached: true, branches: ["feat/a"], isHead: true }),
      fullActions(),
    );
    expect(itemOf(items, "合并 feat/a 到当前分支…")).toMatchObject({
      disabled: true,
      hint: DETACHED_HINT,
    });
    expect(itemOf(items, "修改提交信息…")).toMatchObject({ disabled: true, hint: DETACHED_HINT });
    // 检出 / 新建分支 / 复制类在分离态仍可用（ui-spec §4 矩阵的「可用」列）
    expect(itemOf(items, "检出到 feat/a").disabled).toBeFalsy();
    expect(itemOf(items, "从此处新建分支…").disabled).toBeFalsy();
    expect(itemOf(items, "复制修订号").disabled).toBeFalsy();
  });
});
