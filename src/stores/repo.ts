// 主 store：仓库、提交日志、选中、详情、工作区、同步动作。
// IPC 返回视为类型化契约（见 docs/agents 域规则），本模块是前端唯一业务状态源。
import { create } from "zustand";
import { asGitError, ipc } from "../lib/ipc";
import { applyBlockChoice, parseConflictBlocks } from "../lib/conflict";
import { authorStatsOf, type AuthorStat } from "../lib/filterMenu";
import type {
  AppConfig,
  BranchSummary,
  CommitDetail,
  CommitEntry,
  CompareResult,
  ConflictVersions,
  FileEntry,
  GitOperation,
  LogFilter,
  LogPage,
  RefEntry,
  RepoChange,
  RepoMeta,
  RepoStatus,
  StashEntry,
  UserIdentity,
} from "../lib/types";

/** operation 文案单一来源（横幅 / 继续按钮 / toast 共用） */
export const OPERATION_LABEL: Record<GitOperation, { progress: string; cont: string }> = {
  merge: { progress: "合并进行中", cont: "继续合并" },
  "cherry-pick": { progress: "拣选（cherry-pick）进行中", cont: "继续拣选" },
  revert: { progress: "反转提交（revert）进行中", cont: "继续反转提交" },
  rebase: { progress: "变基进行中", cont: "继续变基" },
};

const PAGE = 200;

/** 图谱筛选的默认值：所有分支 / 全部时间 / 全部提交者（须在 create 之前求值） */
export const EMPTY_LOG_FILTER: LogFilter = { branch: null, since: null, author: null };

/** 写操作后抑制 watcher 事件的窗口：必须 > watcher 的 500ms 防抖，否则抑制不住那一轮 */
export const REPO_CHANGE_SUPPRESS_MS = 1200;

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
    /** 多行输入（提交信息等长文本）：渲染 textarea，Enter 不触发主动作（换行） */
    multiline?: boolean;
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
  /** 仓库已配置的远程名（git remote）：多远程推送选择框与 ref 分类共用 */
  remotes: string[];
  /**
   * 全量引用（分支 / 标签 / 远程 ref）。侧栏的唯一数据源——
   * 不能从 commits 推导：那些 ref 装饰只存在于已加载的分页里，
   * tip 落在窗口外的分支/标签会整个消失。
   */
  refs: RefEntry[];
  filter: string;
  /** 图谱筛选（分支 / 提交者 / 日期）：下推 git 的那三项，与搜索框的客户端子串过滤正交 */
  logFilter: LogFilter;
  /** 仓库解析出的提交身份（user.name / user.email），供「只看我的」；未解析出为 null */
  identity: UserIdentity | null;
  /** 「最近提交者」（按已加载提交统计；提交者筛选生效时保持上一份快照） */
  authorStats: AuthorStat[];
  toasts: Toast[];
  /** 当前打开的通用对话框；null = 关闭 */
  dialog: DialogDesc | null;
  /** 有写操作在飞：期间拒绝再发起其它写操作（US31 防重复触发） */
  writeBusy: boolean;
  /**
   * 刷新闸门状态（单飞 + 合并）：busy 期间来的请求只登记「补跑 + 档位」，
   * 并等补跑那轮落地才 resolve（写操作后的等待语义不退化）。
   */
  refreshBusy: boolean;
  refreshDirty: boolean;
  /** 待补跑那轮的档位：全量请求会把它抬成 true，轻量请求绝不降级 */
  refreshHeavy: boolean;
  refreshWaiters: (() => void)[];
  /** 最近一次写操作（git 调用）落幕的时间戳；窗口内忽略 watcher 事件 */
  lastWriteAt: number;
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

  /** 右栏「比较」模式（与 HEAD 比较，工单 08）：进入后压过提交详情 / 工作区 diff */
  compare: {
    base: string;
    head: string;
    data: CompareResult | null;
    loading: boolean;
  } | null;
  hydrate: () => Promise<void>;
  openRepo: (path: string) => Promise<boolean>;
  /** 弹系统目录选择器，选定即打开（欢迎页与工具栏仓库切换器共用）；取消返回 false */
  pickAndOpenRepo: () => Promise<boolean>;
  removeRecent: (path: string) => Promise<void>;
  closeRepo: () => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  /** 轻量刷新：只重拉 status / stash（工作区或索引变的 watcher 事件走这条） */
  refreshLight: () => Promise<void>;
  /** watcher 事件入口：按变更分类分流，写操作刚结束时整轮抑制 */
  applyRepoChange: (change: RepoChange) => void;
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
  /**
   * 侧栏点击分支/标签/远程：选中其 tip 提交并让列表滚动置顶。
   * tip 尚未加载时先翻页找到它（refs 是全量的，图谱却只加载了前若干页）。
   */
  selectRefTip: (id: string) => Promise<void>;
  /** 关闭右栏面板：改动 tab 收起工作文件 diff，历史 tab 取消选中提交 */
  closeRightPane: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  /** amend=true 时修正上一次提交（--amend，允许零暂存的纯信息修正） */
  commit: (message: string, amend?: boolean) => Promise<boolean>;
  remote: (op: "fetch" | "pull" | "push") => Promise<void>;
  setFilter: (f: string) => void;
  /** 改一项图谱筛选（分支 / 提交者 / 日期）并重取第一页日志 */
  setLogFilter: (patch: Partial<LogFilter>) => Promise<void>;
  /** 清除全部图谱筛选，回到默认视角（所有分支 / 全部时间 / 全部提交者） */
  resetLogFilters: () => Promise<void>;
  /** 用当前筛选重取第一页日志（保留已加载深度），供筛选变更调用 */
  reloadLog: () => Promise<void>;
  pushToast: (kind: Toast["kind"], text: string) => number;
  /** 就地改写某条提示（busy → ok/err 的转场复用同一条，不打断视线） */
  updateToast: (id: number, patch: Partial<Pick<Toast, "kind" | "text">>) => void;
  dismissToast: (id: number) => void;
  /** 复制文本到剪贴板（navigator.clipboard → execCommand 兜底），成功后 toast「已复制<label>」 */
  copyText: (text: string, label: string) => Promise<void>;
  /** 复制提交的完整信息（subject + body，按需拉取详情） */
  copyCommitMessage: (commitId: string) => Promise<void>;
  openDialog: (desc: DialogDesc) => void;
  closeDialog: () => void;
  /** 检出到本地分支；脏工作树时先经安全拦截对话框（ui-spec §4） */
  checkout: (branch: string) => Promise<void>;
  /** 新建分支（对话框表单：名称 + 建完即检出勾选）；返回校验错误给对话框显示 */
  createBranch: (name: string, checkoutAfter: boolean, at?: string) => Promise<string | void>;
  /** 新建分支对话框入口；from 缺省基于当前 HEAD，传入 ref（提交 id / 分支名 / 远程 ref）则基于该处；
   *  suggestName 预填建议分支名（远程分支派生同名分支的场景） */
  createBranchFlow: (from?: { ref: string; label: string }, suggestName?: string) => void;
  /** 删除分支入口：先取未合入计数，按结果弹一次确认或强制删除确认 */
  deleteBranchFlow: (branch: string) => Promise<void>;
  /** 分支改名（对话框表单，预填原名） */
  renameBranchFlow: (branch: string) => void;
  /** 重置当前分支到指定提交（图谱右键入口）：先选模式，硬重置必过脏树拦截 */
  resetBranchTo: (commitId: string) => void;
  /** 当前分支名；分离 HEAD / 空仓库返回 null（无法作为 push 目标） */
  currentBranch: () => string | null;
  /** push 无上游时的建立关联弹框（选远程 → push -u） */
  /** push 无上游时的建立关联弹框（选远程 → push -u）；branch 缺省用当前分支 */
  pushUpstreamFlow: (branch?: string) => Promise<void>;
  /** 推到指定远程（不建立上游）；remote 为空则走「选远程」弹框 */
  pushToFlow: (remote?: string) => Promise<void>;
  /** 当前分支推到所有远程 */
  pushAllRemotesFlow: () => Promise<void>;
  /** 分叉拉取：把上游分支合并进当前分支（确认后由 remote('pull') 错误处理触发） */
  mergeUpstreamFlow: (refName: string) => Promise<void>;
  /** 中止进行中的合并，恢复到合并前状态 */
  abortOperation: () => Promise<void>;
  /** stash 入口：对话框附可选描述，贮藏全部改动（含未跟踪） */
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
  /** 拣选提交到当前分支（脏树拒绝；空提交给跳过/放弃选择） */
  cherryPickFlow: (commitId: string) => Promise<void>;
  /** 反转提交（合并提交解释性拦截；冲突进 operation=revert 流程） */
  revertFlow: (commitId: string) => Promise<void>;
  /** 把本地分支合并进当前分支（冲突进 operation=merge 流程） */
  /** 把本地分支合并进当前分支（冲突进 operation=merge 流程） */
  mergeBranchFlow: (branch: string) => Promise<void>;

  // ── 右键菜单对齐批次（工单 03–09）──
  /** 03：检出远程分支（建同名本地跟踪分支并检出；脏树走既有三选拦截） */
  checkoutRemote: (fullRef: string, branch: string) => Promise<void>;
  /** 03：把某分支推到指定远程的同名分支（不建立、不改变上游关联） */
  pushToRemote: (remote: string, branch: string) => Promise<void>;
  /** 03 / 04：抓取；带远程名只抓该远程，缺省抓全部 */
  fetchRemoteFlow: (remote?: string) => Promise<void>;
  /** 03：删除远程分支（危险项，二次确认） */
  deleteRemoteBranchFlow: (remote: string, branch: string) => Promise<void>;
  /** 04：设置上游分支（对话框输入远程分支，即时校验） */
  setUpstreamFlow: (branch: string) => void;
  /** 04：取消上游关联 */
  unsetUpstream: (branch: string) => Promise<void>;
  /** 04：推送某个本地分支（无上游时弹「建立上游关联并推送」） */
  pushBranchFlow: (branch: string) => Promise<void>;
  /** 04：抓取某个本地分支对应的远程（无上游时全量抓取） */
  fetchForBranch: (branch: string) => Promise<void>;
  /** 05：新建标签（名称 + 可选备注 → 有备注即附注标签） */
  createTagFlow: (commitId: string) => void;
  /** 06：检出该修订（分离 HEAD；脏树走既有三选拦截） */
  checkoutCommitFlow: (commitId: string) => Promise<void>;
  /** 07：把当前分支变基到 <ref>（确认 → 脏树拦截 → 冲突落既有冲突视图） */
  rebaseOntoFlow: (ref: string) => Promise<void>;
  /** 07：变基冲突时跳过本次提交（仅 rebase 进行中可用） */
  skipOperationFlow: () => Promise<void>;
  /** 08：与 HEAD 比较（右栏进入比较模式） */
  compareWithHead: (commitId: string) => Promise<void>;
  /** 08：退出比较模式 */
  closeCompare: () => void;
  /** 09：修改 HEAD 提交信息（对话框预填 + 暂存区警告） */
  amendMessageFlow: (commitId: string) => void;
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
  // git 自身拦截（如检出/合并时改动会被覆盖）的常见场景给可读中文（US32）
  if (/would be overwritten|local changes/i.test(err.message)) {
    return "操作失败：工作区改动会与目标冲突，请先提交或贮藏后重试";
  }
  return `操作失败：${err.message}`;
};

/**
 * 写剪贴板：优先异步 Clipboard API；WebView2 下若不可用（非安全上下文 / 无权限）
 * 回退到 execCommand。两者都失败返回 false，由调用方给错误 toast —— 不静默。
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/** 分支名客户端预检（表单即时反馈；后端仍以 check-ref-format 为准） */
const BAD_BRANCH_CHARS = new Set([" ", "~", "^", ":", "?", "*", "[", "]", "\\", "\t"]);

/** 写操作前的脏工作树预检（cherry-pick / revert 等不允许带脏树进行） */
async function ensureCleanTree(get: () => RepoState): Promise<boolean> {
  const st = await ipc.getStatus().catch(() => null);
  if (st && (st.staged.length > 0 || st.unstaged.length > 0 || st.unmerged.length > 0)) {
      get().pushToast("err", "工作区不干净：请先提交改动或贮藏后再操作");
    return false;
  }
  return true;
}

/** 当前工作区的脏文件清单（已暂存 + 未暂存）；读状态失败视为干净 */
async function dirtyFiles(): Promise<string[]> {
  const st = await ipc.getStatus().catch(() => null);
  return st ? [...st.staged, ...st.unstaged].map((f) => f.path) : [];
}

/**
 * 脏工作树三选拦截（ui-spec §4 安全模型）：干净直接执行；脏则弹「继续 / 贮藏后继续 / 取消」。
 * 检出、检出该修订、变基共用这一模型，文案与主动作的危险级别由调用方给
 * （破坏性主动作必须 `proceedKind: "danger"`，否则 Enter 会误触）。
 */
async function guardDirtyTree(
  get: () => RepoState,
  opts: {
    title: string;
    message: string;
    files: string[];
    proceedLabel: string;
    proceedKind?: "primary" | "danger";
    stashLabel: string;
    stashMessage: string;
    proceed: () => void | Promise<unknown>;
  },
): Promise<void> {
  if (opts.files.length === 0) {
    await opts.proceed();
    return;
  }
  get().openDialog({
    title: opts.title,
    message: opts.message,
    files: opts.files,
    actions: [
      {
        label: opts.proceedLabel,
        kind: opts.proceedKind ?? "primary",
        run: () => void opts.proceed(),
      },
      {
        label: opts.stashLabel,
        kind: "ghost",
        run: () => {
          void (async () => {
            try {
              await ipc.stashPush(opts.stashMessage);
              get().pushToast("ok", "改动已存入贮藏，可随时恢复");
              await opts.proceed();
            } catch (e) {
              get().pushToast("err", await errText(e));
            }
          })();
        },
      },
    ],
  });
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
 * 打「刚写完仓库」的时间戳：抑制窗口的起点是 git 操作刚落幕这一刻。
 * 只给「自己接着会 refresh()」的写路径用 —— 不自己刷新、只靠 watcher 那轮更新的路径
 * （stage / unstage）绝不能打，否则唯一的刷新会被抑制掉，面板停在上一次的状态。
 */
function markWrite(set: (partial: Partial<RepoState>) => void): void {
  set({ lastWriteAt: Date.now() });
}

/**
 * 通用写操作包裹（US31）：writeBusy 期间拒绝新写操作；
 * busy 提示就地转场为 op 返回的文案（ok）或结构化错误（err），完成后刷新；
 * 返回是否成功——调用方据此决定要不要补后续提示，避免失败后仍发成功语义的 toast。
 */
async function runWrite(
  set: (partial: Partial<RepoState>) => void,
  get: () => RepoState,
  busyText: string,
  okText: string,
  op: () => Promise<string | void>,
): Promise<boolean> {
  if (get().writeBusy) {
    get().pushToast("err", "有操作正在进行中，请稍候");
    return false;
  }
  set({ writeBusy: true });
  const id = get().pushToast("busy", busyText);
  try {
    const msg = await op();
    // 抑制窗口的起点是 git 操作刚落幕这一刻（不能放 finally：那会把起点推后一个刷新时长）
    markWrite(set);
    get().updateToast(id, { kind: "ok", text: typeof msg === "string" && msg ? msg : okText });
    await get().refresh();
    return true;
  } catch (e) {
    markWrite(set); // 失败也可能写了 .git（冲突留下的 MERGE_HEAD 等）
    get().updateToast(id, { kind: "err", text: await errText(e) });
    return false;
  } finally {
    set({ writeBusy: false });
  }
}

/**
 * 日志请求代次：换筛选 / 刷新即递增，**旧代次的响应一律丢弃**——
 * 否则慢响应会盖掉新视角的结果（筛选胶囊与列表说的不是同一件事）。
 */
let logToken = 0;

/**
 * 首页日志请求（reloadLog / refresh 共用），顺带自愈一处死结：
 * 筛中的分支被删除/改名后后端会一直报错，而「先刷新 refs 再发现分支没了」是循环依赖
 * （失败那次刷新连 refs 都不落地），图谱与侧栏会双双卡住。所以这里退回「所有分支」
 * 重试一次并提示，让上下文自己恢复。失败返回 null（已提示），调用方保留现有列表。
 */
async function fetchLogFirstPage(
  set: (partial: Partial<RepoState>) => void,
  get: () => RepoState,
  limit: number,
): Promise<LogPage | null> {
  const filter = get().logFilter;
  try {
    return await ipc.getLog(0, limit, filter);
  } catch (e) {
    if (!filter.branch) {
      get().pushToast("err", await errText(e));
      return null;
    }
    const fallback: LogFilter = { ...filter, branch: null };
    set({ logFilter: fallback });
    get().pushToast("err", `分支 ${filter.branch} 已不存在，筛选回到「所有分支」`);
    try {
      return await ipc.getLog(0, limit, fallback);
    } catch (e2) {
      get().pushToast("err", await errText(e2));
      return null;
    }
  }
}

/**
 * 右栏视图修剪：刷新落地后，选中的工作区文件 / stash 条目 / 冲突文件若已消失则收起。
 * 两档刷新共用（调用方都先 set 再调本函数，故这里一律读 state 里的最新一份）。
 */
function pruneViews(set: (partial: Partial<RepoState>) => void, get: () => RepoState): void {
  const status = get().status;
  const stashes = get().stashes;
  // 工作区选中文件可能已被提交/外部变更移走：仍在对应列表则刷新 diff，否则收起
  const wf = get().workFile;
  if (wf) {
    const inList = (list: { path: string }[]) => list.some((f) => f.path === wf);
    const still = !!status && (get().workStaged ? inList(status.staged) : inList(status.unstaged));
    if (still) void get().reloadWorkDiff(wf, get().workStaged);
    else set({ workFile: null, workDiff: null, workDiffLoading: false });
  }
  // 查看中的 stash 条目已消失（被 pop/drop）→ 收起
  const sv = get().stashView;
  if (sv && !stashes.some((s) => s.index === sv.index)) set({ stashView: null });
  // 查看中的冲突文件已被解决 → 收起
  const cv = get().conflictView;
  if (cv && !(status?.unmerged ?? []).some((f) => f.path === cv.path)) set({ conflictView: null });
}

/** 一轮全量刷新：日志首页 + status / summary / stash / remotes / refs / identity */
async function doRefreshOnce(
  set: (partial: Partial<RepoState>) => void,
  get: () => RepoState,
): Promise<void> {
  const { meta } = get();
  if (!meta) return;
  try {
    const token = ++logToken;
    const [page, status, summary, stashes, remotes, refs, identity] = await Promise.all([
      fetchLogFirstPage(set, get, Math.max(PAGE, get().commits.length || PAGE)),
      ipc.getStatus().catch(() => null),
      ipc.getBranchSummary().catch(() => null),
      ipc.stashList().catch(() => []),
      ipc.listRemotes().catch(() => [] as string[]),
      ipc.listRefs().catch(() => [] as RefEntry[]),
      ipc.getUserIdentity().catch(() => null),
    ]);
    set({
      // 期间又有更新的日志请求 → 这份日志页作废，但其余数据面照常落地
      ...(page && token === logToken ? logPagePatch(page, get().logFilter, get()) : {}),
      status,
      summary,
      stashes,
      remotes,
      refs,
      // 身份临时取不到时保留上一份：别把「只看我的」变成灰的
      identity: identity ?? get().identity,
      loadingMore: false,
    });
    pruneViews(set, get);
  } catch (e) {
    get().pushToast("err", await errText(e));
  }
}

/** 一轮轻量刷新：只重拉 status / stash，不碰 log / refs / summary / remotes */
async function doRefreshLightOnce(
  set: (partial: Partial<RepoState>) => void,
  get: () => RepoState,
): Promise<void> {
  if (!get().meta) return;
  const [status, stashes] = await Promise.all([
    ipc.getStatus().catch(() => null),
    ipc.stashList().catch(() => null),
  ]);
  if (!get().meta) return; // 期间关仓库了
  set({ status: status ?? get().status, stashes: stashes ?? get().stashes });
  pruneViews(set, get);
}

/**
 * 刷新闸门：单飞 + 合并。
 * - 已有刷新在飞 → 只登记「待补跑」与请求档位，并等补跑那轮落地才 resolve（写操作后的等待语义不退化）
 * - 补跑那轮跑**最重的那档请求**：期间来了全量请求，补跑就必须是全量，否则 log 会陈旧
 */
async function withRefreshGate(
  set: (partial: Partial<RepoState>) => void,
  get: () => RepoState,
  heavy: boolean,
  run: (heavy: boolean) => Promise<void>,
): Promise<void> {
  if (get().refreshBusy) {
    await new Promise<void>((resolve) =>
      set({
        refreshDirty: true,
        refreshHeavy: get().refreshHeavy || heavy,
        refreshWaiters: [...get().refreshWaiters, resolve],
      }),
    );
    return;
  }
  set({ refreshBusy: true, refreshDirty: false, refreshHeavy: false });
  try {
    do {
      const useHeavy = get().refreshHeavy || heavy;
      set({ refreshDirty: false, refreshHeavy: false });
      await run(useHeavy);
    } while (get().refreshDirty);
  } finally {
    set({ refreshBusy: false });
    // 以下三行之间没有 await，新调用不可能插进来
    const waiters = get().refreshWaiters;
    set({ refreshWaiters: [] });
    waiters.forEach((w) => w());
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
  remotes: [],
  refs: [],
  filter: "",
  logFilter: { ...EMPTY_LOG_FILTER },
  identity: null,
  authorStats: [],
  toasts: [],
  dialog: null,
  writeBusy: false,
  /** 刷新闸门（单飞 + 合并）与写后抑制窗口 */
  refreshBusy: false,
  refreshDirty: false,
  refreshHeavy: false,
  refreshWaiters: [],
  lastWriteAt: 0,
  stashes: [],
  stashView: null,
  conflictView: null,
  compare: null,

  openDialog: (desc) => set({ dialog: desc }),
  closeDialog: () => set({ dialog: null }),

  checkout: async (branch) => {
    await guardDirtyTree(get, {
      title: `检出到 ${branch}`,
      message: "工作区有未提交改动。带着改动检出时，若与目标分支冲突，git 会拒绝且现状不变。",
      files: await dirtyFiles(),
      proceedLabel: "带着改动检出",
      stashLabel: "贮藏后检出",
      stashMessage: "检出前自动贮藏",
      proceed: () =>
        runWrite(set, get, `检出到 ${branch}…`, `已检出到 ${branch}`, async () => {
          await ipc.switchBranch(branch);
        }),
    });
  },

  createBranch: async (name, checkoutAfter, at) => {
    const trimmed = name.trim();
    if (!trimmed) return "分支名不能为空";
    try {
      await ipc.createBranch(trimmed, checkoutAfter, at);
      // 非 runWrite 的写路径同样要打戳：紧接着的 refresh() 是这一轮的收尾
      markWrite(set);
      get().pushToast(
        "ok",
        checkoutAfter ? `已创建并检出到 ${trimmed}` : `已创建分支 ${trimmed}`,
      );
      await get().refresh();
    } catch (e) {
      return (await asGitError(e)).message;
    }
  },

  createBranchFlow: (from, suggestName) => {
    get().openDialog({
      title: "新建分支",
      message: from ? `基于${from.label}创建新分支。` : "基于当前 HEAD 创建新分支。",
      input: {
        initial: suggestName,
        placeholder: "分支名，如 feat/login",
        validate: validateBranchName,
      },
      checkbox: { label: "创建后立即检出", initial: true },
      actions: [
        {
          label: "创建",
          kind: "primary",
          run: (name, checkoutAfter) => get().createBranch(name, checkoutAfter, from?.ref),
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
        actions: [
          {
            label: "继续",
            // 返回 false：接下来打开的强制删除确认框不能被宿主关掉（DialogHost 只在非 false 时 onClose）
            run: () => {
              void forceDelete();
              return false;
            },
          },
        ],
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
              // 非 runWrite 的写路径同样要打戳（同 createBranch）
              markWrite(set);
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
    // 硬重置销毁未提交改动：脏树时先过安全拦截（与检出共用模型；主动作危险样式，避免 Enter 误触）
    const confirmHard = async () => {
      await guardDirtyTree(get, {
        title: "硬重置将丢弃未提交改动",
        message: "硬重置会把工作区与暂存区一起退回目标提交，下列改动将无法找回。",
        files: await dirtyFiles(),
        proceedLabel: "硬重置（丢弃改动）",
        proceedKind: "danger",
        stashLabel: "贮藏后硬重置",
        stashMessage: "硬重置前自动贮藏",
        proceed: () => doReset("hard"),
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


  // ── 工单 03：远程分支 ──────────────────────────────────────────────────────

  checkoutRemote: async (fullRef, branch) => {
    await guardDirtyTree(get, {
      title: `检出 ${fullRef}`,
      message: `会在本地创建分支 ${branch} 并跟踪 ${fullRef}。带着改动检出时，若与目标分支冲突，git 会拒绝且现状不变。`,
      files: await dirtyFiles(),
      proceedLabel: "带着改动检出",
      stashLabel: "贮藏后检出",
      stashMessage: "检出前自动贮藏",
      proceed: () =>
        runWrite(set, get, `检出 ${fullRef}…`, `已检出 ${branch} 并跟踪 ${fullRef}`, async () => {
          await ipc.createBranch(branch, true, fullRef);
        }),
    });
  },

  pushToRemote: async (remote, branch) => {
    await runWrite(set, get, `推送 ${branch} 到 ${remote}…`, "", async () => {
      await ipc.pushTo(remote, branch);
    });
  },

  fetchRemoteFlow: async (remote) => {
    await runWrite(
      set,
      get,
      remote ? `抓取 ${remote}…` : "抓取全部远程…",
      remote ? `已抓取 ${remote}` : "抓取完成",
      async () => {
        await ipc.fetch(remote);
      },
    );
  },

  deleteRemoteBranchFlow: async (remote, branch) => {
    get().openDialog({
      title: `删除远程分支 ${remote}/${branch}`,
      message: "远程分支会被删除，且无法从本地恢复；其他协作者下次抓取时也会看到它消失。",
      actions: [
        {
          label: "删除远程分支",
          kind: "danger",
          run: () => {
            void runWrite(
              set,
              get,
              `删除 ${remote}/${branch}…`,
              `已删除远程分支 ${remote}/${branch}`,
              async () => {
                await ipc.deleteRemoteBranch(remote, branch);
              },
            );
          },
        },
      ],
    });
  },

  // ── 工单 04：上游管理 + 推送 / 抓取入口 ────────────────────────────────────

  setUpstreamFlow: (branch) => {
    const remoteRefs = get()
      .refs.filter((r) => r.kind === "remote")
      .map((r) => r.name);
    get().openDialog({
      title: `设置 ${branch} 的上游分支`,
      message:
        remoteRefs.length > 0
          ? `输入要关联的远程分支，例如 ${remoteRefs[0]}。需要更换已有上游时，先「取消上游关联」再设置。`
          : "仓库里还没有远程分支（先抓取一次），无法设置上游。",
      input: {
        placeholder: "远程分支，如 origin/main",
        validate: (v) => {
          const n = v.trim();
          if (!n) return "上游分支不能为空";
          if (!remoteRefs.includes(n)) return "必须是本仓库已有的远程分支（可先抓取一次）";
          return null;
        },
      },
      actions: [
        {
          label: "设置上游",
          kind: "primary",
          run: async (value) => {
            const upstream = value.trim();
            try {
              await ipc.setUpstream(branch, upstream);
              // 非 runWrite 的写路径同样要打戳
              markWrite(set);
              get().pushToast("ok", `已把 ${branch} 的上游设为 ${upstream}`);
              await get().refresh();
            } catch (e) {
              return (await asGitError(e)).message;
            }
          },
        },
      ],
    });
  },

  unsetUpstream: async (branch) => {
    await runWrite(
      set,
      get,
      `取消 ${branch} 的上游关联…`,
      `已取消 ${branch} 的上游关联`,
      async () => {
        await ipc.unsetUpstream(branch);
      },
    );
  },

  pushBranchFlow: async (branch) => {
    const upstream = get().refs.find((r) => r.kind === "branch" && r.name === branch)?.upstream;
    if (!upstream) {
      await get().pushUpstreamFlow(branch);
      return;
    }
    const remote = upstream.split("/")[0];
    await runWrite(set, get, `推送 ${branch}…`, `已推送 ${branch} 到 ${upstream}`, async () => {
      await ipc.pushTo(remote, branch);
    });
  },

  fetchForBranch: async (branch) => {
    const upstream = get().refs.find((r) => r.kind === "branch" && r.name === branch)?.upstream;
    await get().fetchRemoteFlow(upstream ? upstream.split("/")[0] : undefined);
  },

  // ── 工单 05：新建标签 ──────────────────────────────────────────────────────

  createTagFlow: (commitId) => {
    const short = commitId.slice(0, 7);
    const existing = new Set(get().refs.filter((r) => r.kind === "tag").map((r) => r.name));
    const validateTagName = (v: string): string | null => {
      const n = v.trim();
      if (!n) return "标签名不能为空";
  if (
    [...n].some((ch) => BAD_BRANCH_CHARS.has(ch)) ||
    n.includes("..") ||
    n.includes("@{") ||
    n.includes("//") ||
    n.startsWith("/") ||
    n.endsWith("/") ||
    n.endsWith(".") ||
    /^[.\-]/.test(n) ||
    n.endsWith(".lock")
  ) {
    return "非法标签名（不能含空格 ~ ^ : ? * [ \\，不能以 . 或 - 开头，不能含 // 或 @{，不能以 / 或 . 结尾）";
  }
      if (existing.has(n)) return "已存在同名标签（可在侧栏标签区看到它）";
      return null;
    };
    const create = (name: string, message?: string) => {
      void runWrite(set, get, `新建标签 ${name}…`, `已新建标签 ${name}`, async () => {
        await ipc.createTag(name, commitId, message);
      });
    };
    get().openDialog({
      title: "新建标签",
      message: `在提交 ${short} 上打标签。勾选「附加备注」会生成附注标签（发布点推荐）。`,
      input: { placeholder: "标签名，如 v1.0.0", validate: validateTagName },
      checkbox: { label: "附加备注（生成附注标签）" },
      actions: [
        {
          label: "创建",
          kind: "primary",
          run: (value, withMessage) => {
            const name = value.trim();
            if (!withMessage) {
              create(name);
              return;
            }
            get().openDialog({
              title: `标签 ${name} 的备注`,
              message: "备注会写进附注标签；留空则退化为轻量标签。",
              input: { placeholder: "备注，如「首个可用版本」" },
              actions: [
                {
                  label: "创建附注标签",
                  kind: "primary",
                  run: (msg) => create(name, msg.trim() || undefined),
                },
              ],
            });
            // 返回 false：刚打开的备注框不能被宿主关掉
            return false;
          },
        },
      ],
    });
  },

  // ── 工单 06：检出该修订（分离 HEAD） ───────────────────────────────────────

  checkoutCommitFlow: async (commitId) => {
    const short = commitId.slice(0, 7);
    await guardDirtyTree(get, {
      title: `检出 ${short}（分离 HEAD）`,
      message:
        "检出后 HEAD 停在这个提交上、不在任何分支（分离 HEAD）。查看与提交照常；推送等需要分支的操作要先「从此处新建分支」。",
      files: await dirtyFiles(),
      proceedLabel: "带着改动检出",
      stashLabel: "贮藏后检出",
      stashMessage: "检出前自动贮藏",
      proceed: async () => {
        const ok = await runWrite(
          set,
          get,
          `检出 ${short}…`,
          `已检出 ${short}（分离 HEAD）`,
          async () => {
            await ipc.checkoutCommit(commitId);
          },
        );
        // 失败（脏树冲突 / 写忙）时 runWrite 已经报过错，这里不能再补一句成功语义的提示
        if (ok) {
          get().pushToast("ok", "当前不在任何分支上：可用「从此处新建分支」把提交挂回分支");
        }
      },
    });
  },

  // ── 工单 07：变基 ─────────────────────────────────────────────────────────

  rebaseOntoFlow: async (ref) => {
    if (get().writeBusy) {
      get().pushToast("err", "有操作正在进行中，请稍候");
      return;
    }
    const current = get().currentBranch();
    if (!current) {
      get().pushToast("err", "分离 HEAD：请先「从此处新建分支」，再变基");
      return;
    }
    const upstream = get().summary?.upstream ?? null;
    get().openDialog({
      title: `把 ${current} 变基到 ${ref}`,
      message:
        "变基会把当前分支的本地提交重写到目标基线上（提交哈希改变）。已推送过的分支需要 force push，本应用暂不提供；工作区不干净时会先拦下来。",
      actions: [
        {
          label: "继续",
          kind: "primary",
          run: () => {
            void (async () => {
              await guardDirtyTree(get, {
                title: `变基 ${current} 到 ${ref}`,
                message: "变基需要干净的工作区，带着改动变基可能半途失败。",
                files: await dirtyFiles(),
                proceedLabel: "继续变基",
                stashLabel: "贮藏后变基",
                stashMessage: "变基前自动贮藏",
                proceed: async () => {
                  const headBefore = get().commits[0]?.id ?? null;
                  let done = false;
                  await runWrite(
                    set,
                    get,
                    `变基 ${current} 到 ${ref}…`,
                    `已把 ${current} 变基到 ${ref}`,
                    async () => {
                      await ipc.rebase(ref);
                      done = true;
                    },
                  );
                  // runWrite 的失败分支不刷新——先拉状态再按 operation 分类
                  await get().refresh();
                  const st = get().status;
                  if (st?.operation === "rebase") {
                    get().pushToast(
                      "err",
                      `变基产生冲突：${st.unmerged.length} 个冲突文件，解决后继续、跳过本次提交或中止变基。`,
                    );
                    return;
                  }
                  // 目标已是祖先时 git 直接 exit 0（HEAD 不变）：没有历史被重写，不该提示 force push
                  const headAfter = get().commits[0]?.id ?? null;
                  const rewritten =
                    headBefore !== null && headAfter !== null && headBefore !== headAfter;
                  if (done && upstream && rewritten) {
                    get().pushToast(
                      "ok",
                      "该分支已有上游：历史被重写，推送需要 force push（本应用暂不提供）",
                    );
                  }
                },
              });
            })();
          },
        },
      ],
    });
  },

  skipOperationFlow: async () => {
    if (get().status?.operation !== "rebase") return;
    const ok = await runWrite(set, get, "跳过本次提交…", "已跳过本次提交", async () => {
      await ipc.continueOperation("rebase", "skip");
    });
    await get().refresh();
    // 失败时不要把冲突视图关掉：操作还在进行，用户得能接着处理
    if (ok || get().status?.operation !== "rebase") set({ conflictView: null });
  },

  // ── 工单 08：与 HEAD 比较 ─────────────────────────────────────────────────

  compareWithHead: async (commitId) => {
    set({
      mainTab: "history",
      // 清掉 stash 查看：右栏优先级里 stash 高于比较模式，留着会把比较面板整个挡住（点了像没反应）
      stashView: null,
      compare: { base: "HEAD", head: commitId, data: null, loading: true },
    });
    try {
      const data = await ipc.getCompare("HEAD", commitId);
      if (get().compare?.head === commitId) {
        set({ compare: { base: "HEAD", head: commitId, data, loading: false } });
      }
    } catch (e) {
      if (get().compare?.head === commitId) set({ compare: null });
      get().pushToast("err", await errText(e));
    }
  },

  closeCompare: () => set({ compare: null }),

  // ── 工单 09：修改提交信息（仅 HEAD） ───────────────────────────────────────

  amendMessageFlow: (commitId) => {
    const row = get().commits.find((c) => c.id === commitId);
    if (!row || !row.refs.includes("HEAD")) {
      get().pushToast("err", "只能修改 HEAD 提交的信息（改写更早的历史暂不支持）");
      return;
    }
    const short = commitId.slice(0, 7);
    void (async () => {
      let initial = "";
      try {
        const detail = await ipc.getCommitDetail(commitId);
        const body = detail.body.trim();
        initial = body ? `${detail.meta.subject}\n\n${body}` : detail.meta.subject;
      } catch (e) {
        get().pushToast("err", await errText(e));
        return;
      }
      const staged = get().status?.staged.length ?? 0;
      get().openDialog({
        title: `修改提交信息（${short}）`,
        message:
          staged > 0
            ? `暂存区有 ${staged} 个已暂存文件，将一并并入本次提交（commit --amend 的固有行为）。`
            : "只改写提交信息，不改动文件内容。",
        input: {
          initial,
          multiline: true,
          validate: (v) => (v.trim() ? null : "提交信息不能为空"),
        },
        actions: [
          {
            label: "保存",
            kind: "primary",
            run: (value) => {
              void runWrite(set, get, "修改提交信息…", "已修改提交信息", async () => {
                await ipc.amendMessage(value.trim());
              });
            },
          },
        ],
      });
    })();
  },
  pushToast: (kind, text) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    return id;
  },
  updateToast: (id, patch) =>
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  copyText: async (text, label) => {
    const ok = await writeClipboard(text);
    if (ok) get().pushToast("ok", `已复制${label}`);
    else get().pushToast("err", `复制${label}失败：剪贴板不可用`);
  },

  copyCommitMessage: async (commitId) => {
    try {
      const detail = await ipc.getCommitDetail(commitId);
      await get().copyText(detail.body.trim() || detail.meta.subject, "提交信息");
    } catch (e) {
      get().pushToast("err", await errText(e));
    }
  },

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
        remotes: [],
        filter: "",
        logFilter: { ...EMPTY_LOG_FILTER },
        identity: null,
        authorStats: [],
        loadingMore: false,
        dialog: null,
        stashes: [],
        stashView: null,
        conflictView: null,
        compare: null,
        // 换仓库即清抑制窗口：上一个仓库的写操作绝不能压掉新仓库的第一轮 watcher 刷新
        lastWriteAt: 0,
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

  pickAndOpenRepo: async () => {
    const dir = await ipc.pickDirectory();
    if (!dir) return false;
    return get().openRepo(dir);
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
      remotes: [],
      refs: [],
      logFilter: { ...EMPTY_LOG_FILTER },
      identity: null,
      authorStats: [],
      loadingMore: false,
      dialog: null,
      stashes: [],
      stashView: null,
      conflictView: null,
      compare: null,
      lastWriteAt: 0,
    }),

  loadMore: async () => {
    const { meta, commits, logDone, loadingMore, logFilter } = get();
    if (!meta || logDone || loadingMore) return;
    set({ loadingMore: true });
    // 不自增代次：分页不该把别人的请求作废，只求自己不被更晚的状态盖过
    const token = logToken;
    const len = commits.length;
    try {
      // 页大小随深度几何增长：--topo-order 每页都要全量走历史（性能 smoke 实测），
      // 固定小页会让深滚动退化成 O(页数 × 历史长度)；大页把总次数压到 ~log 级。
      const limit = Math.max(PAGE, Math.floor(len / 4));
      const page = await ipc.getLog(len, limit, logFilter);
      const now = get();
      // 期间换筛选 / 换仓库 / 列表被重取：这一页属于旧视角，丢弃（loadingMore 由新请求复位）
      if (token !== logToken || now.meta !== meta || now.commits.length !== len) return;
      const seen = new Set(commits.map((c) => c.id));
      const fresh = page.commits.filter((c) => !seen.has(c.id));
      const next = [...commits, ...fresh];
      set({
        commits: next,
        logDone: page.done,
        loadingMore: false,
        ...statsPatch(next, logFilter),
      });
    } catch (e) {
      set({ loadingMore: false });
      get().pushToast("err", await errText(e));
    }
  },

  refresh: async () =>
    withRefreshGate(set, get, true, (heavy) =>
      heavy ? doRefreshOnce(set, get) : doRefreshLightOnce(set, get),
    ),

  refreshLight: async () =>
    withRefreshGate(set, get, false, (heavy) =>
      heavy ? doRefreshOnce(set, get) : doRefreshLightOnce(set, get),
    ),

  applyRepoChange: (change) => {
    // 自己刚写完仓库：watcher 那一轮已被写操作自己的 refresh 覆盖
    if (Date.now() - get().lastWriteAt < REPO_CHANGE_SUPPRESS_MS) return;
    if (change.refs || change.head) void get().refresh();
    else void get().refreshLight();
  },

  select: async (id) => {
    // 选中另一个提交即退出比较模式（ui-spec §4 比较模式的退出条件）
    if (get().compare) set({ compare: null });
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

  setMainTab: (tab) => set({ mainTab: tab, compare: null }),

  selectRefTip: async (id) => {
    // refs 是全量的，tip 可能还没被分页加载进来（图谱上根本没有这一行）。
    // 先翻页直到命中或历史见底，否则点了等于没点。
    //
    // 两个坑：loadMore 期间 loadingMore 为 true，此时再调它会直接 return（不能拿来当等待手段，
    // 会空转）；以及 --skip 偏移分页在翻页间 ref 变动时会漏提交，故以"提交数有增长"作为继续条件。
    for (let guard = 0; guard < 50; guard++) {
      for (let w = 0; get().loadingMore && w < 200; w++) {
        await new Promise((r) => setTimeout(r, 10)); // 等在飞的那次翻页落地
      }
      if (get().logDone || get().commits.some((c) => c.id === id)) break;
      const before = get().commits.length;
      await get().loadMore();
      if (get().commits.length === before) break; // 没有新提交，别空转
    }
    // 跳转目标在历史里：无论当前处于哪个 tab，先切回历史再定位
    set({ mainTab: "history", scrollToId: id, scrollNonce: get().scrollNonce + 1 });
    await get().select(id);
  },

  closeRightPane: () => {
    // 比较模式 > 冲突视图 > stash 查看 > 按 tab 语义移除触发条件
    if (get().compare) {
      set({ compare: null });
      return;
    }
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

  commit: async (message, amend) => {
    try {
      await ipc.commit(message, amend);
      // 非 runWrite 的写路径同样要打戳：watcher 的 refs 事件延迟到达，别让它再触发第二轮
      markWrite(set);
      get().pushToast("ok", amend ? "已修正上一次提交" : "提交完成");
      // 分离 HEAD：提交不挂在任何分支上，提示把提交挂回分支（工单 06）
      if (!get().currentBranch()) {
        get().pushToast("ok", "提交未挂在任何分支上，建议「从此处新建分支」把提交挂回分支");
      }
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
      // 非 runWrite 的写路径同样要打戳（fetch / pull / push 都可能改 refs）
      markWrite(set);
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

  /** 当前分支名；分离 HEAD / 空仓库返回 null（无法作为 push 目标） */
  currentBranch: () => {
    const branch = get().summary?.branch ?? get().meta?.branch ?? "";
    return branch && !branch.startsWith("(") ? branch : null;
  },

  pushUpstreamFlow: async (target) => {
    const branch = target ?? get().currentBranch();
    if (!branch) {
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

  pushToFlow: async (remote) => {
    const branch = get().currentBranch();
    if (!branch) {
      get().pushToast("err", "当前不在常规分支上，无法推送");
      return;
    }
    let remotes = get().remotes;
    if (!remote) {
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
      const upstreamRemote = get().summary?.upstream?.split("/")[0];
      get().openDialog({
        title: "推送到指定远程",
        message: `把分支 ${branch} 推送到所选远程的同名分支，不改变已有的上游关联：`,
        actions: [
          ...remotes.map((r) => ({
            label: r === upstreamRemote ? `推送到 ${r}（当前上游）` : `推送到 ${r}`,
            kind: r === upstreamRemote ? ("primary" as const) : ("ghost" as const),
            run: () => void get().pushToFlow(r),
          })),
          ...(remotes.length > 1
            ? [
                {
                  label: `推送到全部远程（${remotes.join("、")}）`,
                  run: () => void get().pushAllRemotesFlow(),
                },
              ]
            : []),
        ],
      });
      return;
    }
    await runWrite(set, get, `推送到 ${remote}…`, "", async () => await ipc.pushTo(remote, branch));
  },

  pushAllRemotesFlow: async () => {
    const branch = get().currentBranch();
    if (!branch) {
      get().pushToast("err", "当前不在常规分支上，无法推送");
      return;
    }
    const remotes = get().remotes;
    if (remotes.length === 0) {
      get().pushToast("err", "仓库没有配置远程，请先在终端 git remote add");
      return;
    }
    await runWrite(
      set,
      get,
      `推送到 ${remotes.join("、")}…`,
      "",
      async () => await ipc.pushAllRemotes(branch),
    );
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
                markWrite(set); // 非 runWrite 的写路径同样要打戳（合并会改 refs / HEAD / index / 工作区）
                get().updateToast(id, { kind: "ok", text: "合并完成" });
                await get().refresh();
              } catch (e) {
                markWrite(set); // 失败也可能写了 .git（MERGE_HEAD 等），下面同样会 refresh
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
      title: "贮藏改动",
      message: "把工作区全部改动（含未跟踪文件）存入贮藏。",
      input: { placeholder: "描述（可选）" },
      actions: [
        {
          label: "贮藏",
          kind: "primary",
          run: (message) => {
            void runWrite(set, get, "贮藏中…", "已存入贮藏", async () => {
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
      markWrite(set); // 同上：stash 恢复也会改 refs（stash 引用）
      get().updateToast(id, { kind: "ok", text: pop ? "已恢复并移除 stash 条目" : "已恢复，stash 条目保留" });
      await get().refresh();
    } catch (e) {
      markWrite(set); // 失败也可能写了 .git（冲突状态），下面同样会 refresh
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
      title: "拣选此提交",
      message: `把 ${commitId.slice(0, 7)} 的改动拣选到当前分支 ${branch}（git cherry-pick）。`,
      actions: [
        {
          label: "拣选",
          kind: "primary",
          run: () => {
            void (async () => {
              await runWrite(set, get, "拣选提交…", "已拣选该提交", async () => {
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
                      label: "放弃本次拣选",
                      kind: "danger",
                      run: () => {
                        void runWrite(set, get, "放弃拣选…", "已放弃本次拣选", async () => {
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
        title: "合并提交无法反转",
        message:
          "这是合并提交：反转它需要指定保留哪条主线（git revert -m），暂不支持。可以先反转其单个父提交序列，或在终端处理。",
        actions: [],
      });
      return;
    }
    if (!(await ensureCleanTree(get))) return;
    const branch = get().summary?.branch ?? get().meta?.branch ?? "";
    get().openDialog({
      title: "反转此提交",
      message: `生成一个反向提交撤销 ${commitId.slice(0, 7)} 的改动，落在分支 ${branch} 上（git revert，不改写历史）。`,
      actions: [
        {
          label: "反转",
          kind: "primary",
          run: () => {
            void runWrite(set, get, "反转提交…", "已反转该提交", async () => {
              try {
                await ipc.revertCommit(commitId);
              } catch (e) {
                await get().refresh();
                if (get().status?.operation === "revert") {
                  get().pushToast("err", `反转提交产生冲突：${get().status?.unmerged.length ?? 0} 个冲突文件，点开冲突文件处理或中止。`);
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

  setLogFilter: async (patch) => {
    set({ logFilter: { ...get().logFilter, ...patch } });
    await get().reloadLog();
  },

  resetLogFilters: async () => {
    set({ logFilter: { ...EMPTY_LOG_FILTER } });
    await get().reloadLog();
  },

  /** 用当前筛选重取第一页；已加载深度保留（换筛选不该让列表缩回一页） */
  reloadLog: async () => {
    const { meta, commits } = get();
    if (!meta) return;
    // 代次自增：连点筛选 / 筛选与刷新交错时，后到的旧响应一律作废
    const token = ++logToken;
    const page = await fetchLogFirstPage(set, get, Math.max(PAGE, commits.length || PAGE));
    if (token !== logToken) return;
    if (!page) {
      set({ loadingMore: false });
      return;
    }
    set({ ...logPagePatch(page, get().logFilter, get()), loadingMore: false });
  },
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

/** 作者统计的落地片段：按提交者筛选中时保持上一份快照（否则列表会被自己的筛选收窄成一个人） */
function statsPatch(commits: CommitEntry[], f: LogFilter): { authorStats?: AuthorStat[] } {
  return f.author ? {} : { authorStats: authorStatsOf(commits) };
}

/** 日志页落地：保留仍存在的选中项（消失则连同详情与文件 tab 一并收起），并刷新作者统计 */
function logPagePatch(page: LogPage, f: LogFilter, prev: RepoState): Partial<RepoState> {
  const stillThere = prev.selectedId !== null && page.commits.some((c) => c.id === prev.selectedId);
  return {
    commits: page.commits,
    logDone: page.done,
    selectedId: stillThere ? prev.selectedId : null,
    detail: stillThere ? prev.detail : null,
    openFiles: stillThere ? prev.openFiles : [],
    detailFile: stillThere ? prev.detailFile : null,
    ...statsPatch(page.commits, f),
  };
}
