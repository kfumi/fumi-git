// 与 Rust serde 结构镜像的类型契约（见 src-tauri/src/git.rs / commands.rs）

export interface CommitEntry {
  id: string;
  short_id: string;
  parents: string[];
  author_name: string;
  author_email: string;
  /** 作者时间（unix 秒） */
  time: number;
  subject: string;
  /** HEAD、分支名、origin/*、tag:名称 */
  refs: string[];
}

export interface LogPage {
  commits: CommitEntry[];
  done: boolean;
}

export interface FileStat {
  path: string;
  old_path: string | null;
  status: 'M' | 'A' | 'D' | 'R';
  add: number;
  del: number;
  binary: boolean;
}

export interface CommitDetail {
  meta: CommitEntry;
  body: string;
  files: FileStat[];
  patch: string | null;
}

export interface FileEntry {
  path: string;
  old_path: string | null;
  /** M / A / D / R；冲突（未合入）条目一律记 'U' */
  status: 'M' | 'A' | 'D' | 'R' | 'U';
}

/** 进行中的多提交操作（决定横幅文案与中止路由） */
export type GitOperation = 'merge' | 'cherry-pick' | 'revert' | 'rebase';

export interface RepoStatus {
  staged: FileEntry[];
  unstaged: FileEntry[];
  /** 合并冲突（未合入）文件；非空即存在冲突，状态记 'U' */
  unmerged: FileEntry[];
  /** 进行中的多提交操作；null = 无 */
  operation: GitOperation | null;
  branch: string;
}

/** 冲突文件三方内容（index stages；文件不在某 stage 时为 null） */
export interface ConflictVersions {
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface RepoMeta {
  name: string;
  path: string;
  branch: string;
}

export interface RepoEntry {
  path: string;
  name: string;
  last_opened: number;
}

export interface AppConfig {
  recent_repos: RepoEntry[];
  theme: ThemeMode;
}

/**
 * 全量引用条目（list_refs）。刻意独立于分页日志：
 * 提交上的 ref 装饰只在已加载的那几行上，老分支/老标签的 tip 落在窗口外就整个丢失。
 */
export interface RefEntry {
  /** 短名：本地分支 `main`、远程 ref `origin/main`、标签 `v1.0.0` */
  name: string;
  kind: 'branch' | 'remote' | 'tag';
  /** tip 提交 id；附注标签已剥离到所标注的提交 */
  tip: string;
  /** 上游短名（`origin/main`）；无上游或非分支为 null */
  upstream: string | null;
  /** 创建时间（unix 秒；标签按此倒序） */
  time: number;
}

export interface BranchSummary {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** stash 条目（index 即 stash@{N} 的 N，0 = 最新） */
export interface StashEntry {
  index: number;
  /** reflog 描述：自定义 message 或 "WIP on <branch>: …" */
  message: string;
  /** 创建时间（unix 秒） */
  time: number;
}

export type ThemeMode = 'dark' | 'light' | 'system';

/** Rust GitError 的序列化形态 */
export interface GitError {
  kind: 'NotARepo' | 'BareRepo' | 'NoUpstream' | 'NonFastForward' | 'NothingToCommit' | 'CommandFailed' | 'Io';
  message: string;
}

/** 两提交比较结果（get_compare）：base..head 的文件统计与统一 diff */
export interface CompareResult {
  /** 比较基准（前端传 "HEAD" 时为其所指提交） */
  base: CommitEntry;
  /** 被比较的提交 */
  head: CommitEntry;
  files: FileStat[];
  /** 统一 diff 全文；无差异时为空串 */
  /** 统一 diff 全文；两端内容一致（无差异）为 null */
  patch: string | null;
}
