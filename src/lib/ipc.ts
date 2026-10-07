// 类型化 IPC 封装 —— 前端禁止绕过本模块直接 invoke 裸字符串命令
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AppConfig,
  BranchSummary,
  CommitDetail,
  ConflictVersions,
  GitError,
  GitOperation,
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

  /** 丢弃未暂存改动（未暂存组 M/D 行，从 index 恢复工作区） */
  discardWorktree: (paths: string[]) => cmd<void>("discard_worktree", { paths }),
  /** 删除未跟踪文件（未暂存组 'A' 行） */
  deleteUntracked: (paths: string[]) => cmd<void>("delete_untracked", { paths }),
  /** 丢弃已暂存改动（M/D/R 行，index+工作区一起退回 HEAD；重命名需附 old_path） */
  discardStaged: (paths: string[]) => cmd<void>("discard_staged", { paths }),
  /** 丢弃已暂存新增文件（已暂存组 'A' 行，从 index 移除并删文件） */
  discardStagedNew: (paths: string[]) => cmd<void>("discard_staged_new", { paths }),
  /** 全部丢弃：tracked 退回 HEAD + 清掉未跟踪；合并进行中会被拒绝 */
  discardAll: () => cmd<void>("discard_all"),
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
  /** 推到指定远程的同名分支（不建立上游）——多远程仓库用 */
  pushTo: (remote: string, branch: string) => cmd<string>("push_to", { remote, branch }),
  /** 当前分支推到所有远程 */
  pushAllRemotes: (branch: string) => cmd<string>("push_all_remotes", { branch }),
  listRemotes: () => cmd<string[]>("list_remotes"),
  mergeRef: (refName: string) => cmd<string>("merge_upstream", { refName }),
  abortOperation: (op: GitOperation) => cmd<void>("abort_operation", { op }),
  conflictVersions: (path: string) => cmd<ConflictVersions>("conflict_versions", { path }),
  /** 工作区文件原文（冲突解决视图展示结果用） */
  readWorktreeFile: (path: string) => cmd<string>("read_worktree_file", { path }),
  /** 写回工作区文件（冲突块取舍拼装结果；不 touch index） */
  writeWorktreeFile: (path: string, content: string) =>
    cmd<void>("write_worktree_file", { path, content }),
  /** 选边解决：整文件采用我方/对方并标记已解决 */
  resolveTake: (path: string, ours: boolean) => cmd<void>("resolve_take", { path, ours }),
  /** 完成进行中的操作（--continue，沿用默认提交信息） */
  continueOperation: (op: GitOperation) => cmd<string>("continue_operation", { op }),
  /** 用系统默认应用打开文件（手动编辑冲突） */
  openInEditor: (path: string) => cmd<void>("open_file_in_editor", { path }),
  /** 还原普通提交（合并提交被后端拦截） */
  revertCommit: (hash: string) => cmd<string>("revert_commit", { hash }),
  /** 摘取单提交（空提交返回 NothingToCommit） */
  cherryPick: (hash: string) => cmd<string>("cherry_pick", { hash }),
  /** 跳过卡住的空 cherry-pick */
  cherryPickSkip: () => cmd<void>("cherry_pick_skip"),
  /** 空提交场景下仍然提交（--allow-empty） */
  cherryPickKeep: () => cmd<string>("cherry_pick_keep"),
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
