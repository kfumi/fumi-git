// 类型化 IPC 封装 —— 前端禁止绕过本模块直接 invoke 裸字符串命令
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AppConfig,
  BranchSummary,
  CommitDetail,
  GitError,
  LogPage,
  RepoMeta,
  RepoStatus,
  StashEntry,
} from "./types";

const cmd = <T,>(name: string, args?: Record<string, unknown>): Promise<T> =>
  invoke<T>(name, args);

/** 把 invoke 的拒绝值规整为 GitError（Rust 侧是带 kind/message 的对象） */
export async function asGitError(e: unknown): Promise<GitError> {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    return e as GitError;
  }
  return { kind: "CommandFailed", message: String(e) };
}

export const ipc = {
  getConfig: () => cmd<AppConfig>("get_app_config"),
  setTheme: (mode: string) => cmd<void>("set_theme", { mode }),
  removeRecent: (path: string) => cmd<void>("remove_recent", { path }),

  /** 弹出系统目录选择器；取消返回 null */
  pickDirectory: () =>
    openDialog({ directory: true, multiple: false, title: "选择 git 仓库目录" }) as Promise<
      string | null
    >,
  openRepo: (path: string) => cmd<RepoMeta>("open_repo", { path }),

  getLog: (skip: number, limit: number) => cmd<LogPage>("get_log", { skip, limit }),
  getCommitDetail: (hash: string) => cmd<CommitDetail>("get_commit_detail", { hash }),
  getStatus: () => cmd<RepoStatus>("get_status"),
  /** 工作区单文件 diff：staged=true 读已暂存（diff --cached），否则未暂存 */
  getWorktreeDiff: (staged: boolean, path: string) =>
    cmd<string>("get_worktree_diff", { staged, path }),
  getBranchSummary: () => cmd<BranchSummary>("get_branch_summary"),

  switchBranch: (name: string) => cmd<void>("switch_branch", { name }),
  stashPush: (message?: string) => cmd<void>("stash_push", { message }),
  stashList: () => cmd<StashEntry[]>("stash_list"),
  stashDiff: (index: number) => cmd<string>("stash_diff", { index }),
  stashApply: (index: number, pop: boolean) => cmd<void>("stash_apply", { index, pop }),
  stashDrop: (index: number) => cmd<void>("stash_drop", { index }),
  createBranch: (name: string, checkout: boolean, startPoint?: string) =>
    cmd<void>("create_branch", { name, checkout, startPoint: startPoint ?? null }),
  resetBranch: (target: string, mode: "soft" | "mixed" | "hard") =>
    cmd<void>("reset_branch", { target, mode }),
  deleteBranch: (name: string, force: boolean) => cmd<void>("delete_branch", { name, force }),
  branchUnmergedCount: (name: string) => cmd<number>("branch_unmerged_count", { name }),
  renameBranch: (oldName: string, newName: string) =>
    cmd<void>("rename_branch", { old: oldName, new: newName }),

  stage: (paths: string[]) => cmd<void>("stage_paths", { paths }),
  unstage: (paths: string[]) => cmd<void>("unstage_paths", { paths }),
  commit: (message: string) => cmd<string>("commit_staged", { message }),

  fetch: () => cmd<string>("fetch_remote"),
  pull: () => cmd<string>("pull_remote"),
  push: () => cmd<string>("push_remote"),
  pushUpstream: (remote: string, branch: string) =>
    cmd<string>("push_upstream", { remote, branch }),
  listRemotes: () => cmd<string[]>("list_remotes"),
  mergeUpstream: (refName: string) => cmd<string>("merge_upstream", { refName }),
  abortMerge: () => cmd<void>("abort_merge"),
};

export function listenRepoChanged(cb: () => void): Promise<() => void> {
  // 动态引入避免模块级依赖事件 API 的类型噪音
  return import("@tauri-apps/api/event").then(({ listen }) =>
    listen("repo-changed", cb).then((un) => {
      return () => {
        un();
      };
    }),
  );
}

export type { GitError };
