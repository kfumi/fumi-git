//! git CLI 封装层 —— 唯一的 Git 后端（ADR：禁止引入 libgit2/gitoxide 作为行为源）。
//!
//! 所有 Git 读写都经过这里 spawn 真实 git 进程、解析 porcelain 输出，
//! 由此免费继承用户的 gitconfig、hooks、credential helper 与 SSH agent。
//! 测试使用真实 git 在临时目录构造夹具仓库，不 mock git 本身。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/// 结构化错误：前端据此渲染引导/指引，而不是裸报错。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum GitError {
    NotARepo(String),
    BareRepo(String),
    NoUpstream(String),
    NonFastForward(String),
    NothingToCommit(String),
    CommandFailed(String),
    Io(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::NotARepo(m)
            | GitError::BareRepo(m)
            | GitError::NoUpstream(m)
            | GitError::NonFastForward(m)
            | GitError::NothingToCommit(m)
            | GitError::CommandFailed(m)
            | GitError::Io(m) => write!(f, "{m}"),
        }
    }
}

impl From<std::io::Error> for GitError {
    fn from(e: std::io::Error) -> Self {
        GitError::Io(e.to_string())
    }
}

pub type GitResult<T> = Result<T, GitError>;

/// 单次 git 调用的完整输出（测试断言 stderr 用）。
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

fn spawn_git(dir: Option<&Path>, args: &[&str], stdin: Option<&str>) -> GitResult<GitOutput> {
    use std::io::Write;
    let mut cmd = Command::new("git");
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    // 路径原样输出（非 ASCII 不转义），所有子命令统一生效
    cmd.arg("-c").arg("core.quotepath=off");
    cmd.args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_OPTIONAL_LOCKS", "0");
    let mut child = cmd.spawn()?;
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .ok_or_else(|| GitError::Io("stdin 不可用".into()))?
            .write_all(input.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        success: out.status.success(),
    })
}

/// 已打开的工作树仓库。路径恒为 `rev-parse --show-toplevel` 归一化的仓库根。
#[derive(Clone)]
pub struct GitRepo {
    pub root: PathBuf,
}

impl GitRepo {
    /// 打开目录：非仓库 / 裸仓库分别给出结构化错误。
    pub fn open(dir: &Path) -> GitResult<GitRepo> {
        if !dir.is_dir() {
            return Err(GitError::NotARepo(format!(
                "目录不存在：{}",
                dir.display()
            )));
        }
        let out = spawn_git(Some(dir), &["rev-parse", "--show-toplevel"], None)?;
        if out.success {
            let root = PathBuf::from(out.stdout.trim());
            return Ok(GitRepo { root });
        }
        let bare = spawn_git(Some(dir), &["rev-parse", "--is-bare-repository"], None)?;
        if bare.success && bare.stdout.trim() == "true" {
            return Err(GitError::BareRepo(
                "裸仓库（bare repository）暂不支持，请打开包含工作区的仓库".into(),
            ));
        }
        Err(GitError::NotARepo(format!(
            "「{}」不是 git 仓库：可在终端执行 git init 后重试",
            dir.display()
        )))
    }

    /// 运行命令，失败时把 stderr 收进结构化错误。
    pub fn run(&self, args: &[&str]) -> GitResult<String> {
        let out = spawn_git(Some(&self.root), args, None)?;
        if !out.success {
            return Err(GitError::CommandFailed(out.stderr.trim().to_string()));
        }
        Ok(out.stdout)
    }

    pub fn run_with_stdin(&self, args: &[&str], input: &str) -> GitResult<String> {
        let out = spawn_git(Some(&self.root), args, Some(input))?;
        if !out.success {
            return Err(GitError::CommandFailed(out.stderr.trim().to_string()));
        }
        Ok(out.stdout)
    }

    pub fn run_ok(&self, args: &[&str]) -> bool {
        spawn_git(Some(&self.root), args, None)
            .map(|o| o.success)
            .unwrap_or(false)
    }

    pub fn current_branch(&self) -> String {
        if let Ok(b) = self.run(&["symbolic-ref", "--short", "HEAD"]) {
            return b.trim().to_string();
        }
        // 分离 HEAD
        match self.run(&["rev-parse", "--short", "HEAD"]) {
            Ok(h) => format!("(HEAD detached at {})", h.trim()),
            Err(_) => "(空仓库)".to_string(),
        }
    }

    pub fn head_exists(&self) -> bool {
        self.run_ok(&["rev-parse", "--verify", "-q", "HEAD"])
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoMeta {
    pub name: String,
    pub path: String,
    pub branch: String,
}

pub fn repo_meta(repo: &GitRepo) -> RepoMeta {
    let name = repo
        .root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.root.to_string_lossy().into_owned());
    RepoMeta {
        name,
        path: repo.root.to_string_lossy().into_owned(),
        branch: repo.current_branch(),
    }
}

// ── 提交历史 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct CommitEntry {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// 作者时间（unix 秒）
    pub time: i64,
    pub subject: String,
    /// 装饰 ref：HEAD、分支名、origin/*、`tag:<name>`
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogPage {
    pub commits: Vec<CommitEntry>,
    /// 本页不足 limit 即历史已尽
    pub done: bool,
}

const LOG_FORMAT: &str =
    "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e";

fn parse_decorations(d: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if d.trim().is_empty() {
        return refs;
    }
    for part in d.split(", ") {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if let Some(b) = p.strip_prefix("HEAD -> ") {
            refs.push("HEAD".into());
            refs.push(b.to_string());
        } else if let Some(t) = p.strip_prefix("tag:") {
            // git 装饰输出为 `tag: v1.0`（冒号带空格），统一归一化为 `tag:v1.0`
            refs.push(format!("tag:{}", t.trim()));
        } else {
            refs.push(p.to_string()); // 分支名 / origin/*
        }
    }
    refs
}

fn parse_log_output(raw: &str) -> Vec<CommitEntry> {
    let mut commits = Vec::new();
    for record in raw.split('\x1e') {
        let record = record.trim_start_matches(['\n', '\r', ' ']);
        if record.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = record.split('\x1f').collect();
        if f.len() < 8 {
            continue;
        }
        commits.push(CommitEntry {
            id: f[0].trim().to_string(),
            short_id: f[1].trim().to_string(),
            parents: f[2]
                .split_whitespace()
                .map(|s| s.to_string())
                .collect(),
            author_name: f[3].to_string(),
            author_email: f[4].to_string(),
            time: f[5].trim().parse().unwrap_or(0),
            subject: f[6].to_string(),
            refs: parse_decorations(f[7]),
        });
    }
    commits
}

/// 全分支拓扑序提交日志（children 恒排在 parent 之前），供前端建图。
pub fn get_log(repo: &GitRepo, skip: usize, limit: usize) -> GitResult<LogPage> {
    let skip = skip.to_string();
    let count = limit.to_string();
    let raw = repo.run(&[
        "log",
        "--all",
        "--topo-order",
        &format!("--skip={skip}"),
        &format!("--max-count={count}"),
        &format!("--format={LOG_FORMAT}"),
    ])?;
    let commits = parse_log_output(&raw);
    let done = commits.len() < limit;
    Ok(LogPage { commits, done })
}

// ── 提交详情与 diff ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FileStat {
    pub path: String,
    /// 重命名前的路径（仅 R 状态）
    pub old_path: Option<String>,
    /// M / A / D / R
    pub status: char,
    pub add: u32,
    pub del: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub meta: CommitEntry,
    pub body: String,
    pub files: Vec<FileStat>,
    /// 统一 diff 原文；合并提交为 None（展示父引用）
    pub patch: Option<String>,
}

fn parse_numstat(raw: &str) -> Vec<FileStat> {
    let mut files = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut it = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let (add, del, binary) = match (a.parse::<u32>(), d.parse::<u32>()) {
            (Ok(x), Ok(y)) => (x, y, false),
            _ => (0, 0, true),
        };
        let (path, old_path, status) = if let Some(both) = p.strip_prefix('{') {
            // `{old => new}` 段内重命名 / `old => new` 整路径重命名
            match both.split_once(" => ") {
                Some((o, n)) if n.ends_with('}') => (
                    n.trim_end_matches('}').to_string(),
                    Some(o.to_string()),
                    'R',
                ),
                _ => (p.to_string(), None, 'M'),
            }
        } else if let Some((o, n)) = p.split_once(" => ") {
            (n.to_string(), Some(o.to_string()), 'R')
        } else {
            (p.to_string(), None, 'M')
        };
        files.push(FileStat {
            path,
            old_path,
            status,
            add,
            del,
            binary,
        });
    }
    files
}

pub fn get_commit_detail(repo: &GitRepo, hash: &str) -> GitResult<CommitDetail> {
    let safe = hash.trim();
    if safe.is_empty() || !safe.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::CommandFailed("非法提交哈希".into()));
    }
    // 元信息（复用日志格式）
    let raw = repo.run(&[
        "show",
        "-s",
        &format!("--format={LOG_FORMAT}"),
        safe,
    ])?;
    let mut commits = parse_log_output(&raw);
    let meta = commits
        .pop()
        .ok_or_else(|| GitError::CommandFailed("提交不存在".into()))?;

    let body = repo
        .run(&["show", "-s", "--format=%b", safe])?
        .trim()
        .to_string();

    // 状态字母用 name-status 精确判定（A/D/M/R），行数统计用 numstat。
    let ns_raw = repo.run(&[
        "show",
        "--format=",
        "--name-status",
        "-M",
        safe,
    ])?;
    let num_raw = repo.run(&[
        "show",
        "--format=",
        "--numstat",
        "-M",
        safe,
    ])?;
    let stats = parse_numstat(&num_raw);
    let statuses = parse_name_status(&ns_raw);
    let files: Vec<FileStat> = stats
        .into_iter()
        .map(|mut f| {
            if let Some(st) = statuses.get(&f.path) {
                f.status = *st;
            } else if let Some(st) = f.old_path.as_ref().and_then(|o| statuses.get(o)) {
                f.status = *st;
            }
            f
        })
        .collect();

    let patch = if meta.parents.len() > 1 {
        None
    } else {
        Some(repo.run(&["show", "--format=", "--patch", safe])?)
    };

    Ok(CommitDetail {
        meta,
        body,
        files,
        patch,
    })
}

fn parse_name_status(raw: &str) -> std::collections::HashMap<String, char> {
    let mut map = std::collections::HashMap::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut it = line.splitn(2, '\t');
        let (Some(st), Some(p)) = (it.next(), it.next()) else {
            continue;
        };
        let ch = st.chars().next().unwrap_or('M');
        // name-status 对重命名是 `R100\t<old>\t<new>`，新路径取最后一个 tab 段
        let new_path = p.split('\t').next_back().unwrap_or(p);
        map.insert(new_path.trim().to_string(), ch);
    }
    map
}

// ── 工作区状态 / 暂存 / 提交 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub old_path: Option<String>,
    /// M / A / D / R
    pub status: char,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoStatus {
    pub staged: Vec<FileEntry>,
    pub unstaged: Vec<FileEntry>,
    /// 合并冲突（未合入）文件；非空即存在冲突
    pub unmerged: Vec<FileEntry>,
    /// 进行中的多提交操作（merge / cherry-pick / revert）
    pub operation: Option<Operation>,
    pub branch: String,
}

pub fn get_status(repo: &GitRepo) -> GitResult<RepoStatus> {
    let raw = repo.run(&["status", "--porcelain", "-z"])?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut unmerged = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(rec) = it.next() {
        let mut chars = rec.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let path = rec[2..].to_string();
        // 重命名条目跟随第二个 NUL 字段 = 原路径
        let (old_path, x, y) = if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            let orig = it.next().unwrap_or("").to_string();
            (Some(orig), x, y)
        } else {
            (None, x, y)
        };
        let path = path.trim().to_string();
        if path.is_empty() {
            continue;
        }
        // 冲突条目独立成组（状态一律记 'U'），不再进暂存/未暂存列表
        if is_unmerged(x, y) {
            unmerged.push(FileEntry {
                path,
                old_path,
                status: 'U',
            });
            continue;
        }
        if x != ' ' && x != '?' {
            staged.push(FileEntry {
                path: path.clone(),
                old_path: old_path.clone(),
                status: x,
            });
        }
        if y != ' ' || x == '?' {
            let st = if x == '?' { 'A' } else { y };
            unstaged.push(FileEntry {
                path,
                old_path,
                status: st,
            });
        }
    }
    Ok(RepoStatus {
        staged,
        unstaged,
        unmerged,
        operation: read_operation(repo),
        branch: repo.current_branch(),
    })
}

/// 工作区文件 diff：staged=true 读已暂存改动（`diff --cached`），否则未暂存（`diff`）。
/// 只取单个文件的 patch 文本，供右栏 diff 面板直接渲染。
pub fn worktree_diff(repo: &GitRepo, staged: bool, path: &str) -> GitResult<String> {
    let safe = path.trim();
    if safe.is_empty() {
        return Err(GitError::CommandFailed("文件路径为空".into()));
    }
    if staged {
        repo.run(&["diff", "--cached", "--", safe])
    } else {
        repo.run(&["diff", "--", safe])
    }
}

pub fn stage(repo: &GitRepo, paths: &[String]) -> GitResult<()> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    repo.run(&args)?;
    Ok(())
}

pub fn unstage(repo: &GitRepo, paths: &[String]) -> GitResult<()> {
    if repo.head_exists() {
        let mut args = vec!["reset", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        repo.run(&args)?;
    } else {
        let mut args = vec!["rm", "--cached", "--force", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        repo.run(&args)?;
    }
    Ok(())
}

pub fn commit(repo: &GitRepo, message: &str) -> GitResult<String> {
    if message.trim().is_empty() {
        return Err(GitError::NothingToCommit("提交信息不能为空".into()));
    }
    let st = get_status(repo)?;
    if st.staged.is_empty() {
        return Err(GitError::NothingToCommit("没有已暂存的改动".into()));
    }
    repo.run_with_stdin(&["commit", "--quiet", "-F", "-"], message)?;
    Ok(repo.run(&["rev-parse", "HEAD"])?.trim().to_string())
}

// ── 分支 / 工作树 / stash ───────────────────────────────────────────────────

/// 迁出到已有本地分支。工作区改动与目标分支冲突时由 git 拦截，错误原样上抛。
pub fn switch_branch(repo: &GitRepo, name: &str) -> GitResult<()> {
    let name = branch_arg(name)?;
    repo.run(&["switch", name])?;
    Ok(())
}

/// 暂存全部改动（含未跟踪文件）。没有可暂存内容时报错，避免空 stash。
pub fn stash_push(repo: &GitRepo, message: Option<&str>) -> GitResult<()> {
    let st = get_status(repo)?;
    if st.staged.is_empty() && st.unstaged.is_empty() {
        return Err(GitError::NothingToCommit("没有可暂存的改动".into()));
    }
    let msg = message.map(str::trim).filter(|m| !m.is_empty());
    match msg {
        Some(m) => repo.run(&["stash", "push", "--include-untracked", "--message", m])?,
        None => repo.run(&["stash", "push", "--include-untracked"])?,
    };
    Ok(())
}

/// 分支名参数统一守卫：trim + 空名拒绝（switch/delete/计数共用同一文案）。
fn branch_arg(name: &str) -> GitResult<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::CommandFailed("分支名为空".into()));
    }
    Ok(name)
}

/// 分支名预检：空名 / 非法名 / 已存在时给出面向用户的中文错误。
/// 合法性复用 git 自身的 check-ref-format（与命令行行为完全一致）。
fn ensure_branch_name_valid(repo: &GitRepo, name: &str) -> GitResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::CommandFailed("分支名不能为空".into()));
    }
    if name.ends_with(".lock") || name.contains("..") || name.starts_with('-') {
        return Err(GitError::CommandFailed(format!("非法分支名：{name}")));
    }
    if repo
        .run(&["check-ref-format", "--branch", name])
        .is_err()
    {
        return Err(GitError::CommandFailed(format!(
            "非法分支名：{name}（不能含空格、~ ^ : ? * [ \\ 等）"
        )));
    }
    if repo.run_ok(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]) {
        return Err(GitError::CommandFailed(format!("分支 {name} 已存在")));
    }
    Ok(())
}

/// 新建分支；checkout=true 时建完即迁出。start_point 缺省 = 当前 HEAD。
pub fn create_branch(
    repo: &GitRepo,
    name: &str,
    checkout: bool,
    start_point: Option<&str>,
) -> GitResult<()> {
    ensure_branch_name_valid(repo, name)?;
    let name = name.trim();
    let start = start_point.map(str::trim).filter(|s| !s.is_empty());
    match (checkout, start) {
        (true, Some(sp)) => {
            repo.run(&["switch", "--create", name, sp])?;
        }
        (true, None) => {
            repo.run(&["switch", "--create", name])?;
        }
        (false, Some(sp)) => {
            repo.run(&["branch", name, sp])?;
        }
        (false, None) => {
            repo.run(&["branch", name])?;
        }
    }
    Ok(())
}

/// 删除本地分支。force=false 时 git 拒绝未合入分支（-d），force=true 强删（-D）。
/// 删除当前分支由 git 自身拦截。
pub fn delete_branch(repo: &GitRepo, name: &str, force: bool) -> GitResult<()> {
    let name = branch_arg(name)?;
    let flag = if force { "-D" } else { "-d" };
    repo.run(&["branch", flag, name])?;
    Ok(())
}

/// 分支上尚未合入当前 HEAD 的提交数（0 = 已合入）。供删除前的防丢确认。
pub fn branch_unmerged_count(repo: &GitRepo, name: &str) -> GitResult<u32> {
    let name = branch_arg(name)?;
    let out = repo.run(&["rev-list", "--count", &format!("HEAD..{name}")])?;
    out.trim()
        .parse()
        .map_err(|_| GitError::CommandFailed(format!("无法解析提交计数：{out}")))
}

/// 分支改名（old 不存在 / new 非法或已存在时由预检或 git 拦截）。
pub fn rename_branch(repo: &GitRepo, old: &str, new: &str) -> GitResult<()> {
    let old = branch_arg(old)?;
    ensure_branch_name_valid(repo, new)?;
    repo.run(&["branch", "--move", old, new.trim()])?;
    Ok(())
}

/// 将当前分支重置到目标提交。target 仅接受十六进制哈希（UI 只传提交 id）；
/// 模式 = soft（保留改动在暂存区）/ mixed（保留在工作区）/ hard（丢弃，脏树拦截在前端）。
pub fn reset_branch(repo: &GitRepo, target: &str, mode: &str) -> GitResult<()> {
    let mode = match mode {
        "soft" | "mixed" | "hard" => mode,
        other => return Err(GitError::CommandFailed(format!("非法 reset 模式：{other}"))),
    };
    let target = target.trim();
    if target.is_empty() || !target.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::CommandFailed("非法提交哈希".into()));
    }
    repo.run(&["reset", &format!("--{mode}"), target])?;
    Ok(())
}

// ── 分叉拉取：最小 merge ────────────────────────────────────────────────────

fn is_unmerged(x: char, y: char) -> bool {
    // porcelain 冲突对：UU AA DD AU UA DU UD
    matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'))
}

/// 进行中的多提交操作（决定横幅文案与 abort 路由）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum Operation {
    #[serde(rename = "merge")]
    Merge,
    #[serde(rename = "cherry-pick")]
    CherryPick,
    #[serde(rename = "revert")]
    Revert,
}

/// 依据 sequencer 状态文件识别进行中的操作（互斥，优先级即检出顺序）。
fn read_operation(repo: &GitRepo) -> Option<Operation> {
    let has = |name: &str| repo.run_ok(&["rev-parse", "--verify", "--quiet", name]);
    if has("MERGE_HEAD") {
        Some(Operation::Merge)
    } else if has("CHERRY_PICK_HEAD") {
        Some(Operation::CherryPick)
    } else if has("REVERT_HEAD") {
        Some(Operation::Revert)
    } else {
        None
    }
}

/// 合并把 <ref>（通常为上游分支如 origin/main）到当前分支。
/// 冲突时返回 CommandFailed（stderr 含 CONFLICT 详情），仓库进入合并中状态，
/// 由前端列出冲突文件并提供「中止合并」出口。
pub fn merge_ref(repo: &GitRepo, ref_name: &str) -> GitResult<String> {
    let ref_name = ref_name.trim();
    if ref_name.is_empty() {
        return Err(GitError::CommandFailed("合并目标为空".into()));
    }
    let out = repo.run(&["merge", "--no-edit", ref_name])?;
    Ok(out.trim().to_string())
}

/// 中止进行中的操作（merge --abort / cherry-pick --abort / revert --abort），
/// 恢复到操作前状态。仅在对应操作进行中可用。
pub fn abort_operation(repo: &GitRepo, op: Operation) -> GitResult<()> {
    let current = read_operation(repo);
    if current != Some(op) {
        return Err(GitError::CommandFailed("当前没有进行中的对应操作".into()));
    }
    let cmd = match op {
        Operation::Merge => "merge",
        Operation::CherryPick => "cherry-pick",
        Operation::Revert => "revert",
    };
    repo.run(&[cmd, "--abort"])?;
    Ok(())
}

/// 冲突文件的三方内容：index stages（`:1:` 共同祖先 / `:2:` 我方 / `:3:` 对方）。
/// 文件不在某个 stage 中（如单侧新增）时对应项为 None。
#[derive(Debug, Clone, Serialize)]
pub struct ConflictVersions {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

pub fn conflict_versions(repo: &GitRepo, path: &str) -> GitResult<ConflictVersions> {
    let path = path.trim();
    if path.is_empty() || path.contains("..") || path.starts_with('/') {
        return Err(GitError::CommandFailed("非法文件路径".into()));
    }
    let stage = |n: u8| repo.run(&["show", &format!(":{n}:{path}")]).ok();
    Ok(ConflictVersions {
        base: stage(1),
        ours: stage(2),
        theirs: stage(3),
    })
}

/// 读取工作区文件原文（冲突解决视图展示结果用）。拒绝仓库外路径。
pub fn read_worktree_file(repo: &GitRepo, path: &str) -> GitResult<String> {
    let path = validate_repo_path(path)?;
    let full = repo.root.join(&path);
    if !full.is_file() {
        return Err(GitError::CommandFailed(format!("文件不存在：{path}")));
    }
    std::fs::read_to_string(&full).map_err(|e| GitError::Io(e.to_string()))
}

/// 把内容写回工作区文件（冲突块取舍的拼装结果）。拒绝仓库外路径；不 touch index。
pub fn write_worktree_file(repo: &GitRepo, path: &str, content: &str) -> GitResult<()> {
    let path = validate_repo_path(path)?;
    std::fs::write(repo.root.join(&path), content).map_err(|e| GitError::Io(e.to_string()))
}

/// 路径守卫：拒绝空路径、目录穿越、绝对路径。
fn validate_repo_path(path: &str) -> GitResult<String> {
    let path = path.trim();
    if path.is_empty() || path.contains("..") || path.starts_with('/') || path.starts_with('\\') || path.contains(':') {
        return Err(GitError::CommandFailed("非法文件路径".into()));
    }
    Ok(path.to_string())
}

/// 选边解决：整个文件采用我方/对方版本（checkout --ours/--theirs 后 add 标记已解决）。
pub fn resolve_take(repo: &GitRepo, path: &str, ours: bool) -> GitResult<()> {
    let path = validate_repo_path(path)?;
    let side = if ours { "--ours" } else { "--theirs" };
    repo.run(&["checkout", side, "--", &path])?;
    repo.run(&["add", "--", &path])?;
    Ok(())
}

/// 完成进行中的操作（--continue）。冲突未清空时拒绝；
/// 以内置空 editor 运行，沿用 git 生成的默认提交信息，不弹交互编辑器。
pub fn continue_operation(repo: &GitRepo, op: Operation) -> GitResult<String> {
    let current = read_operation(repo);
    if current != Some(op) {
        return Err(GitError::CommandFailed("当前没有进行中的对应操作".into()));
    }
    let st = get_status(repo)?;
    if !st.unmerged.is_empty() {
        return Err(GitError::CommandFailed(format!(
            "还有 {} 个冲突文件未解决",
            st.unmerged.len()
        )));
    }
    let cmd = match op {
        Operation::Merge => "merge",
        Operation::CherryPick => "cherry-pick",
        Operation::Revert => "revert",
    };
    repo.run(&["-c", "core.editor=true", cmd, "--continue"])?;
    Ok("已完成".into())
}

// ── stash 管理 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct StashEntry {
    /// stash 索引（stash@{N} 的 N，0 = 最新）
    pub index: u32,
    /// reflog 描述：自定义 message 或 "WIP on <branch>: …"
    pub message: String,
    /// 创建时间（unix 秒）
    pub time: i64,
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// stash 列表（0 = 最新）。
pub fn stash_list(repo: &GitRepo) -> GitResult<Vec<StashEntry>> {
    let out = repo.run(&["stash", "list", "--format=%gd%x1f%gs%x1f%ct"])?;
    let mut list = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 3 {
            continue;
        }
        // f[0] 形如 "stash@{2}"
        let index = f[0]
            .rsplit('{')
            .next()
            .and_then(|s| s.trim_end_matches('}').parse().ok())
            .unwrap_or(list.len() as u32);
        list.push(StashEntry {
            index,
            message: f[1].to_string(),
            time: f[2].trim().parse().unwrap_or(0),
        });
    }
    Ok(list)
}

/// stash 条目 diff（只读展示）。未跟踪文件存于 stash 的第三父提交（^3），
/// 存在时一并拼入，保证与 push --include-untracked 对称。
pub fn stash_diff(repo: &GitRepo, index: u32) -> GitResult<String> {
    let refname = stash_ref(index);
    let mut out = repo.run(&["stash", "show", "--patch", &refname])?;
    if repo.run_ok(&["rev-parse", "--verify", "--quiet", &format!("{refname}^3")]) {
        if let Ok(untracked) = repo.run(&["show", "--format=", "--patch", &format!("{refname}^3")]) {
            if !out.is_empty() && !untracked.is_empty() {
                out.push('\n');
            }
            out.push_str(&untracked);
        }
    }
    Ok(out)
}

/// 恢复 stash：pop = 成功后移除条目（git 在冲突时自动保留条目），apply = 保留副本。
pub fn stash_apply(repo: &GitRepo, index: u32, pop: bool) -> GitResult<()> {
    let cmd = if pop { "pop" } else { "apply" };
    repo.run(&["stash", cmd, &stash_ref(index)])?;
    Ok(())
}

/// 删除 stash 条目。
pub fn stash_drop(repo: &GitRepo, index: u32) -> GitResult<()> {
    repo.run(&["stash", "drop", &stash_ref(index)])?;
    Ok(())
}

// ── 丢弃工作区改动（不可恢复，确认在前端） ─────────────────────────────────

/// 丢弃未暂存改动：从 index 恢复工作区（适用于未暂存组的 M/D 行）。
pub fn discard_worktree(repo: &GitRepo, paths: &[String]) -> GitResult<()> {
    let mut args = vec!["restore", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    repo.run(&args)?;
    Ok(())
}

/// 删除未跟踪文件（未暂存组中状态 'A' 的行）。
pub fn delete_untracked(repo: &GitRepo, paths: &[String]) -> GitResult<()> {
    let mut args = vec!["clean", "--force", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    repo.run(&args)?;
    Ok(())
}

/// 丢弃已暂存改动：index 与工作区一起退回 HEAD（M/D/R 行，重命名需附 old_path）。
/// 状态 'A'（新暂存文件）不适用本函数——HEAD 中不存在，走 discard_staged_new。
pub fn discard_staged(repo: &GitRepo, paths: &[String]) -> GitResult<()> {
    let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    repo.run(&args)?;
    Ok(())
}

/// 丢弃已暂存的新增文件：从 index 移除并删除工作区文件。
pub fn discard_staged_new(repo: &GitRepo, paths: &[String]) -> GitResult<()> {
    let mut args = vec!["rm", "--force", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    repo.run(&args)?;
    Ok(())
}

/// 全部丢弃：tracked 的 index+工作区退回 HEAD，未跟踪文件/目录一并清掉。
/// 有进行中的多提交操作（合并/摘取/还原）时拒绝，避免破坏冲突现场。
pub fn discard_all(repo: &GitRepo) -> GitResult<()> {
    if read_operation(repo).is_some() {
        return Err(GitError::CommandFailed(
            "有进行中的合并/摘取/还原操作，请先完成或中止".into(),
        ));
    }
    repo.run(&["restore", "--source=HEAD", "--staged", "--worktree", "--", ":/"])?;
    repo.run(&["clean", "-f", "-d"])?;
    Ok(())
}

// ── 远程同步 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct BranchSummary {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

pub fn get_branch_summary(repo: &GitRepo) -> GitResult<BranchSummary> {
    let branch = repo.current_branch();
    let up = repo.run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let upstream = match up {
        Ok(u) => Some(u.trim().to_string()),
        Err(_) => None,
    };
    let (ahead, behind) = match &upstream {
        Some(u) => {
            let out = repo.run(&["rev-list", "--left-right", "--count", &format!("HEAD...{u}")])?;
            let mut it = out.split_whitespace();
            (
                it.next().and_then(|s| s.parse().ok()).unwrap_or(0),
                it.next().and_then(|s| s.parse().ok()).unwrap_or(0),
            )
        }
        None => (0, 0),
    };
    Ok(BranchSummary {
        branch,
        upstream,
        ahead,
        behind,
    })
}

pub fn fetch(repo: &GitRepo) -> GitResult<String> {
    repo.run(&["fetch"]).map(|_| "抓取完成".into())
}

pub fn pull(repo: &GitRepo) -> GitResult<String> {
    match repo.run(&["pull", "--ff-only"]) {
        Ok(_) => Ok("拉取完成".into()),
        Err(GitError::CommandFailed(stderr)) => {
            if stderr.contains("Not possible to fast-forward") || stderr.contains("divergent") {
                Err(GitError::NonFastForward(
                    "本地与远程历史分叉，无法快进。可选择把远程分支合并进来".into(),
                ))
            } else {
                Err(GitError::CommandFailed(stderr))
            }
        }
        Err(e) => Err(e),
    }
}

/// push 被拒时的结构化映射：非快进 / 远程领先 → NonFastForward，其余原样。
fn map_push_err(stderr: String) -> GitError {
    let s = stderr.to_lowercase();
    if s.contains("non-fast-forward") || s.contains("rejected") || s.contains("fetch first") {
        GitError::NonFastForward(
            "推送被拒：远程有本地没有的提交。请先拉取（无法快进时会引导合并）".into(),
        )
    } else {
        GitError::CommandFailed(stderr)
    }
}

pub fn push(repo: &GitRepo) -> GitResult<String> {
    let upstream = repo.run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if upstream.is_err() {
        let branch = repo.current_branch();
        return Err(GitError::NoUpstream(format!(
            "分支 {branch} 还没有上游分支。请建立上游关联后推送"
        )));
    }
    repo.run(&["push"]).map_err(|e| match e {
        GitError::CommandFailed(stderr) => map_push_err(stderr),
        other => other,
    })?;
    Ok("推送完成".into())
}

/// 本地分支还没有上游时：让用户选远程，一次性建立关联并推送（push -u）。
pub fn push_upstream(repo: &GitRepo, remote: &str, branch: &str) -> GitResult<String> {
    let remote = remote.trim();
    let branch = branch.trim();
    if remote.is_empty() || branch.is_empty() {
        return Err(GitError::CommandFailed("远程或分支名为空".into()));
    }
    repo.run(&["push", "--quiet", "-u", remote, branch])
        .map_err(|e| match e {
            GitError::CommandFailed(stderr) => map_push_err(stderr),
            other => other,
        })?;
    Ok(format!("已推送 {branch} 并关联 {remote}/{branch}"))
}

/// git remote 列表，供 push -u 的远程选择框。
pub fn list_remotes(repo: &GitRepo) -> GitResult<Vec<String>> {
    let out = repo.run(&["remote"])?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    /// 直接以原始 git 命令构造夹具（被测对象是封装层，夹具必须用"裸 git"搭）。
    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .expect("git 命令执行失败");
        assert!(
            out.status.success(),
            "git {args:?} 失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn repo() -> TempDir {
        let t = TempDir::new().unwrap();
        git(t.path(), &["init", "-q", "-b", "main"]);
        git(t.path(), &["config", "user.email", "test@fumigit.dev"]);
        git(t.path(), &["config", "user.name", "Fumi Test"]);
        git(t.path(), &["config", "commit.gpgsign", "false"]);
        git(t.path(), &["config", "core.autocrlf", "false"]);
        t
    }

    fn commit_file(dir: &Path, path: &str, content: &str, msg: &str) -> String {
        let p = dir.join(path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
        git(dir, &["add", "--", path]);
        git(dir, &["commit", "-q", "-m", msg]);
        git(dir, &["rev-parse", "HEAD"]).trim().to_string()
    }

    // ── 打开仓库 ──

    #[test]
    fn open_rejects_non_repo_and_bare() {
        let t = TempDir::new().unwrap();
        assert!(matches!(
            GitRepo::open(t.path()),
            Err(GitError::NotARepo(_))
        ));
        let b = TempDir::new().unwrap();
        git(b.path(), &["init", "-q", "--bare"]);
        assert!(matches!(GitRepo::open(b.path()), Err(GitError::BareRepo(_))));
    }

    #[test]
    fn open_normalizes_to_root_and_reports_branch() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        let sub = t.path().join("sub");
        fs::create_dir_all(&sub).unwrap();
        let r = GitRepo::open(&sub).unwrap();
        assert_eq!(r.root, t.path());
        let meta = repo_meta(&r);
        assert_eq!(meta.branch, "main");
        assert_eq!(meta.name, t.path().file_name().unwrap().to_string_lossy());
    }

    // ── 日志解析 ──

    #[test]
    fn log_linear_history_and_done_flag() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "first");
        commit_file(t.path(), "a.txt", "2", "second");
        commit_file(t.path(), "a.txt", "3", "third");
        let r = GitRepo::open(t.path()).unwrap();
        let page = get_log(&r, 0, 10).unwrap();
        assert_eq!(page.commits.len(), 3);
        assert!(page.done);
        assert_eq!(page.commits[0].subject, "third");
        assert_eq!(page.commits[2].subject, "first");
        assert!(page.commits[0].refs.contains(&"HEAD".to_string()));
        assert!(page.commits[0].refs.contains(&"main".to_string()));
    }

    #[test]
    fn log_pagination() {
        let t = repo();
        for i in 0..5 {
            commit_file(t.path(), "a.txt", &i.to_string(), &format!("c{i}"));
        }
        let r = GitRepo::open(t.path()).unwrap();
        let p1 = get_log(&r, 0, 2).unwrap();
        assert_eq!(p1.commits.len(), 2);
        assert!(!p1.done);
        assert_eq!(p1.commits[0].subject, "c4");
        let p3 = get_log(&r, 4, 2).unwrap();
        assert_eq!(p3.commits.len(), 1);
        assert!(p3.done);
        assert_eq!(p3.commits[0].subject, "c0");
    }

    #[test]
    fn log_merge_topology_children_before_parents() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        let f1 = commit_file(t.path(), "f.txt", "1", "feat 1");
        let f2 = commit_file(t.path(), "f.txt", "2", "feat 2");
        git(t.path(), &["checkout", "-q", "main"]);
        let m1 = commit_file(t.path(), "b.txt", "x", "main side");
        git(
            t.path(),
            &["merge", "-q", "--no-ff", "-m", "Merge feat", "feat"],
        );
        let r = GitRepo::open(t.path()).unwrap();
        let page = get_log(&r, 0, 20).unwrap();
        let ids: Vec<&str> = page.commits.iter().map(|c| c.id.as_str()).collect();
        let merge = page.commits.first().unwrap();
        assert_eq!(merge.subject, "Merge feat");
        assert_eq!(merge.parents.len(), 2);
        let idx = |h: &str| ids.iter().position(|i| i.starts_with(&h[..7])).unwrap();
        let (i_f1, i_f2, i_m1, i_merge) = (idx(&f1), idx(&f2), idx(&m1), 0);
        assert!(i_merge < i_m1);
        assert!(i_merge < i_f2);
        assert!(i_f2 < i_f1);
        assert!(merge.refs.contains(&"HEAD".to_string()));
        // feat 分支尖在 f2（feat 的最后一个提交）
        let feat_tip = page.commits.iter().find(|c| c.id == f2).unwrap();
        assert!(feat_tip.refs.contains(&"feat".to_string()));
    }

    #[test]
    fn log_detached_head() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "one");
        commit_file(t.path(), "a.txt", "2", "two");
        git(t.path(), &["checkout", "-q", "--detach", "HEAD~1"]);
        let r = GitRepo::open(t.path()).unwrap();
        assert!(r.current_branch().starts_with("(HEAD detached at"));
        let page = get_log(&r, 0, 5).unwrap();
        // main 仍指向 "two"；HEAD 装饰在 "one" 上
        let two = page.commits.iter().find(|c| c.subject == "two").unwrap();
        let one = page.commits.iter().find(|c| c.subject == "one").unwrap();
        assert!(two.refs.contains(&"main".to_string()));
        assert!(!two.refs.contains(&"HEAD".to_string()));
        assert!(one.refs.contains(&"HEAD".to_string()));
    }

    #[test]
    fn log_unicode_paths_and_messages() {
        let t = repo();
        commit_file(t.path(), "中文 目录/文件.txt", "内容", "feat: 中文提交信息");
        let r = GitRepo::open(t.path()).unwrap();
        let page = get_log(&r, 0, 5).unwrap();
        assert_eq!(page.commits[0].subject, "feat: 中文提交信息");
        let detail = get_commit_detail(&r, &page.commits[0].id).unwrap();
        assert_eq!(detail.files[0].path, "中文 目录/文件.txt");
    }

    // ── 详情与 diff ──

    #[test]
    fn detail_add_modify_delete_rename_binary() {
        let t = repo();
        commit_file(t.path(), "keep.txt", "v1", "init");
        commit_file(t.path(), "add.txt", "new", "add file");
        // 修改
        fs::write(t.path().join("keep.txt"), "v2").unwrap();
        git(t.path(), &["add", "."]);
        git(t.path(), &["commit", "-q", "-m", "modify keep"]);
        // 重命名
        git(t.path(), &["mv", "add.txt", "renamed.txt"]);
        git(t.path(), &["commit", "-q", "-m", "rename add"]);
        // 删除（真删除文件后 add -A 提交）
        fs::remove_file(t.path().join("keep.txt")).unwrap();
        git(t.path(), &["add", "-A"]);
        git(t.path(), &["commit", "-q", "-m", "del keep"]);
        // 二进制文件
        fs::write(t.path().join("bin.dat"), [0u8, 1, 2, 0, 255]).unwrap();
        git(t.path(), &["add", "."]);
        git(t.path(), &["commit", "-q", "-m", "add binary"]);

        let r = GitRepo::open(t.path()).unwrap();
        let page = get_log(&r, 0, 10).unwrap();

        let by_subject = |s: &str| {
            page.commits
                .iter()
                .find(|c| c.subject == s)
                .map(|c| c.id.clone())
                .unwrap()
        };

        let d_add = get_commit_detail(&r, &by_subject("add file")).unwrap();
        assert_eq!(d_add.files.len(), 1);
        assert_eq!(d_add.files[0].status, 'A');
        assert!(d_add.patch.as_ref().unwrap().contains("+new"));

        let d_mod = get_commit_detail(&r, &by_subject("modify keep")).unwrap();
        assert_eq!(d_mod.files[0].status, 'M');

        let d_ren = get_commit_detail(&r, &by_subject("rename add")).unwrap();
        assert_eq!(d_ren.files[0].status, 'R');
        assert_eq!(d_ren.files[0].old_path.as_deref(), Some("add.txt"));

        let d_del = get_commit_detail(&r, &by_subject("del keep")).unwrap();
        assert_eq!(d_del.files[0].status, 'D');

        let d_bin = get_commit_detail(&r, &by_subject("add binary")).unwrap();
        assert!(d_bin.files[0].binary);
    }

    #[test]
    fn detail_merge_has_no_patch_but_parents() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        commit_file(t.path(), "f.txt", "1", "feat work");
        git(t.path(), &["checkout", "-q", "main"]);
        git(t.path(), &["merge", "-q", "--no-ff", "-m", "Merge it", "feat"]);
        let r = GitRepo::open(t.path()).unwrap();
        let page = get_log(&r, 0, 5).unwrap();
        let d = get_commit_detail(&r, &page.commits[0].id).unwrap();
        assert_eq!(d.meta.parents.len(), 2);
        assert!(d.patch.is_none());
    }

    // ── 状态 / 暂存 / 提交 ──

    #[test]
    fn status_stage_commit_roundtrip() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "init");
        commit_file(t.path(), "b.txt", "1", "init b");
        // a 修改、b 删除、c 新增未跟踪
        fs::write(t.path().join("a.txt"), "2").unwrap();
        fs::remove_file(t.path().join("b.txt")).unwrap();
        fs::write(t.path().join("c.txt"), "new").unwrap();

        let r = GitRepo::open(t.path()).unwrap();
        let st = get_status(&r).unwrap();
        assert_eq!(st.staged.len(), 0);
        let unstaged: Vec<&FileEntry> = st.unstaged.iter().collect();
        assert_eq!(unstaged.len(), 3);
        let find = |p: &str| unstaged.iter().find(|f| f.path == p).unwrap();
        assert_eq!(find("a.txt").status, 'M');
        assert_eq!(find("b.txt").status, 'D');
        assert_eq!(find("c.txt").status, 'A');

        // 暂存 a 与 c
        stage(&r, &["a.txt".into(), "c.txt".into()]).unwrap();
        let st2 = get_status(&r).unwrap();
        assert_eq!(st2.staged.len(), 2);
        assert!(st2.staged.iter().any(|f| f.path == "a.txt" && f.status == 'M'));
        assert!(st2.staged.iter().any(|f| f.path == "c.txt" && f.status == 'A'));
        assert_eq!(st2.unstaged.len(), 1);

        // 取消暂存 c
        unstage(&r, &["c.txt".into()]).unwrap();
        let st3 = get_status(&r).unwrap();
        assert_eq!(st3.staged.len(), 1);

        // 提交：空信息 / 无暂存 被 阻止
        assert!(matches!(
            commit(&r, "  "),
            Err(GitError::NothingToCommit(_))
        ));
        let hash = commit(&r, "feat: 暂存 a 修改").unwrap();
        assert_eq!(hash.len(), 40);

        let st4 = get_status(&r).unwrap();
        assert_eq!(st4.staged.len(), 0);
        assert_eq!(st4.unstaged.len(), 2); // b 删除 + c 未跟踪
        let page = get_log(&r, 0, 3).unwrap();
        assert_eq!(page.commits[0].subject, "feat: 暂存 a 修改");
    }

    #[test]
    fn worktree_diff_staged_vs_unstaged() {
        let t = repo();
        commit_file(t.path(), "a.txt", "line1\n", "init");
        // 二次修改并暂存；再改出未暂存部分
        fs::write(t.path().join("a.txt"), "line1\nline2\n").unwrap();
        let r = GitRepo::open(t.path()).unwrap();
        stage(&r, &["a.txt".into()]).unwrap();
        fs::write(t.path().join("a.txt"), "line1\nline2\nline3\n").unwrap();

        // 未暂存 diff：含 line3，不含 line2
        let unstaged = worktree_diff(&r, false, "a.txt").unwrap();
        assert!(unstaged.contains("+line3"), "unstaged: {unstaged}");
        assert!(!unstaged.contains("+line2"));

        // 已暂存 diff：含 line2，不含 line3
        let staged = worktree_diff(&r, true, "a.txt").unwrap();
        assert!(staged.contains("+line2"), "staged: {staged}");
        assert!(!staged.contains("+line3"));

        // 空路径拒绝
        assert!(matches!(
            worktree_diff(&r, false, "  "),
            Err(GitError::CommandFailed(_))
        ));
    }

    #[test]
    fn unstage_on_initial_commit_head_missing() {
        let t = repo();
        fs::write(t.path().join("a.txt"), "1").unwrap();
        git(t.path(), &["add", "."]);
        let r = GitRepo::open(t.path()).unwrap();
        let st = get_status(&r).unwrap();
        assert_eq!(st.staged.len(), 1);
        unstage(&r, &["a.txt".into()]).unwrap();
        let st2 = get_status(&r).unwrap();
        assert!(st2.staged.is_empty());
        assert_eq!(st2.unstaged.len(), 1);
    }

    #[test]
    fn commit_runs_hooks_and_surfaces_rejection() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "init");
        let hook = t.path().join(".git").join("hooks");
        fs::create_dir_all(&hook).unwrap();
        fs::write(
            hook.join("pre-commit"),
            "#!/bin/sh\necho hook-says-no >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(hook.join("pre-commit"), fs::Permissions::from_mode(0o755));
        }
        fs::write(t.path().join("a.txt"), "2").unwrap();
        git(t.path(), &["add", "."]);
        let r = GitRepo::open(t.path()).unwrap();
        let err = commit(&r, "should fail").unwrap_err();
        assert!(err.to_string().contains("hook-says-no"), "{err}");
    }

    // ── 远程同步 ──

    /// 建 bare 远端并把工作仓推上去（夹具用裸 git，push -u 建立上游）。
    fn repo_with_origin() -> (TempDir, TempDir) {
        let origin = TempDir::new().unwrap();
        git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
        let work = repo();
        commit_file(work.path(), "a.txt", "1", "base");
        git(
            work.path(),
            &["remote", "add", "origin", origin.path().to_str().unwrap()],
        );
        git(work.path(), &["push", "-q", "-u", "origin", "main"]);
        (origin, work)
    }

    #[test]
    fn branch_summary_sync_ahead_behind() {
        let (_origin, work) = repo_with_origin();
        let r = GitRepo::open(work.path()).unwrap();
        let s0 = get_branch_summary(&r).unwrap();
        assert_eq!(s0.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s0.ahead, s0.behind), (0, 0));

        commit_file(work.path(), "a.txt", "2", "local only");
        let s1 = get_branch_summary(&r).unwrap();
        assert_eq!((s1.ahead, s1.behind), (1, 0));
    }

    #[test]
    fn fetch_pull_fast_forward_and_divergence() {
        // 克隆端产生远程提交 → 落后 → pull 快进
        let (origin, work) = repo_with_origin();
        let clone_dir = TempDir::new().unwrap();
        git(
            clone_dir.path(),
            &[
                "clone",
                "-q",
                origin.path().to_str().unwrap(),
                clone_dir.path().join("c2").to_str().unwrap(),
            ],
        );
        let c2 = clone_dir.path().join("c2");
        commit_file(&c2, "remote.txt", "r1", "remote commit");
        git(&c2, &["push", "-q", "origin", "main"]);

        let r = GitRepo::open(work.path()).unwrap();
        assert_eq!(get_branch_summary(&r).unwrap().behind, 0);
        fetch(&r).unwrap();
        let s = get_branch_summary(&r).unwrap();
        assert_eq!((s.ahead, s.behind), (0, 1));
        pull(&r).unwrap();
        assert_eq!(get_branch_summary(&r).unwrap().behind, 0);
        assert!(work.path().join("remote.txt").exists());

        // 分叉：本地 +1、远程 +1 → pull 必须失败且不改动仓库
        commit_file(work.path(), "local.txt", "l1", "local diverge");
        commit_file(&c2, "remote2.txt", "r2", "remote diverge");
        git(&c2, &["push", "-q", "origin", "main"]);
        fetch(&r).unwrap();
        let s2 = get_branch_summary(&r).unwrap();
        assert_eq!((s2.ahead, s2.behind), (1, 1));
        assert!(matches!(pull(&r), Err(GitError::NonFastForward(_))));
        assert!(!work.path().join("remote2.txt").exists());
    }

    #[test]
    fn push_no_upstream_is_structured_error() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        let r = GitRepo::open(t.path()).unwrap();
        assert!(matches!(push(&r), Err(GitError::NoUpstream(_))));
    }

    #[test]
    fn push_ahead_succeeds() {
        let (origin, work) = repo_with_origin();
        commit_file(work.path(), "a.txt", "2", "ahead");
        let r = GitRepo::open(work.path()).unwrap();
        push(&r).unwrap();
        let log = git(origin.path(), &["log", "--oneline", "-1", "main"]);
        assert!(log.contains("ahead"));
    }

    #[test]
    fn log_tag_decoration_parsed() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        commit_file(t.path(), "a.txt", "2", "tagged");
        git(t.path(), &["tag", "v0.1.0"]);
        let r = GitRepo::open(t.path()).unwrap();
        let page = get_log(&r, 0, 5).unwrap();
        let tip = page.commits.iter().find(|c| c.subject == "tagged").unwrap();
        assert!(tip.refs.contains(&"tag:v0.1.0".to_string()));
        assert!(tip.refs.contains(&"main".to_string()));
    }

    #[test]
    fn log_empty_repo_returns_empty_done_page() {
        let t = repo();
        let r = GitRepo::open(t.path()).unwrap();
        let page = get_log(&r, 0, 200).unwrap();
        assert!(page.commits.is_empty());
        assert!(page.done);
        assert_eq!(r.current_branch(), "main");
    }

    #[test]
    fn push_rejected_non_fast_forward_is_structured() {
        let (origin, work) = repo_with_origin();
        // 远程被第三方推进
        let clone_dir = TempDir::new().unwrap();
        git(
            clone_dir.path(),
            &["clone", "-q", origin.path().to_str().unwrap(), "c2"],
        );
        let c2 = clone_dir.path().join("c2");
        commit_file(&c2, "other.txt", "x", "third party");
        git(&c2, &["push", "-q", "origin", "main"]);
        // 本地基于旧历史直接提交 → push 必须被拒
        commit_file(work.path(), "a.txt", "3", "local diverge");
        let head_before = git(work.path(), &["rev-parse", "HEAD"]);
        let r = GitRepo::open(work.path()).unwrap();
        assert!(matches!(push(&r), Err(GitError::NonFastForward(_))));
        // push 被拒不改动本地状态
        assert_eq!(git(work.path(), &["rev-parse", "HEAD"]).trim(), head_before.trim());
    }

    // ── 分支迁出 / stash ──

    #[test]
    fn switch_branch_moves_head() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        git(t.path(), &["branch", "feat"]);
        let r = GitRepo::open(t.path()).unwrap();
        assert_eq!(r.current_branch(), "main");
        switch_branch(&r, "feat").unwrap();
        assert_eq!(r.current_branch(), "feat");
        // 空名拒绝
        assert!(matches!(
            switch_branch(&r, "  "),
            Err(GitError::CommandFailed(_))
        ));
        // 不存在的分支由 git 报结构化错误
        assert!(matches!(
            switch_branch(&r, "no-such-branch"),
            Err(GitError::CommandFailed(_))
        ));
    }

    #[test]
    fn switch_branch_dirty_conflict_is_structured_error() {
        let t = repo();
        commit_file(t.path(), "a.txt", "main\n", "base");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        commit_file(t.path(), "a.txt", "feat\n", "feat side");
        git(t.path(), &["checkout", "-q", "main"]);
        // main 侧把 a.txt 改出未提交内容 → 迁到 feat 必然冲突
        fs::write(t.path().join("a.txt"), "dirty\n").unwrap();
        let r = GitRepo::open(t.path()).unwrap();
        assert!(matches!(
            switch_branch(&r, "feat"),
            Err(GitError::CommandFailed(_))
        ));
        // 仓库仍在 main，未提交改动原样保留
        assert_eq!(r.current_branch(), "main");
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "dirty\n");
    }

    #[test]
    fn stash_push_cleans_worktree_and_keeps_untracked() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        fs::write(t.path().join("a.txt"), "2").unwrap();
        fs::write(t.path().join("new.txt"), "untracked").unwrap();
        let r = GitRepo::open(t.path()).unwrap();

        stash_push(&r, Some("半成品"), ).unwrap();
        let st = get_status(&r).unwrap();
        assert!(st.staged.is_empty() && st.unstaged.is_empty());
        assert!(!t.path().join("new.txt").exists());
        let list = git(t.path(), &["stash", "list", "--format=%gs"]);
        assert!(list.contains("半成品"), "stash list: {list}");

        // 干净工作树再 stash = 结构化报错
        assert!(matches!(
            stash_push(&r, None),
            Err(GitError::NothingToCommit(_))
        ));
    }

    #[test]
    fn branch_create_delete_rename_and_unmerged_count() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        let r = GitRepo::open(t.path()).unwrap();

        // 新建：默认仅创建；checkout=true 则建完即迁出
        create_branch(&r, "feat", false, None).unwrap();
        assert_eq!(r.current_branch(), "main");
        create_branch(&r, "topic", true, None).unwrap();
        assert_eq!(r.current_branch(), "topic");

        // 重名 / 非法名被预检拦截
        assert!(matches!(
            create_branch(&r, "feat", false, None),
            Err(GitError::CommandFailed(m)) if m.contains("已存在")
        ));
        assert!(matches!(
            create_branch(&r, "bad name", false, None),
            Err(GitError::CommandFailed(m)) if m.contains("非法分支名")
        ));
        assert!(matches!(
            create_branch(&r, "", false, None),
            Err(GitError::CommandFailed(m)) if m.contains("不能为空")
        ));

        // 未合入计数：topic 上有独立提交 → 相对 main 为 2；main 相对自身为 0
        switch_branch(&r, "main").unwrap();
        commit_file(t.path(), "f1.txt", "1", "topic one");
        switch_branch(&r, "topic").unwrap();
        commit_file(t.path(), "f1.txt", "2", "topic one");
        commit_file(t.path(), "f2.txt", "1", "topic two");
        switch_branch(&r, "main").unwrap();
        assert_eq!(branch_unmerged_count(&r, "topic").unwrap(), 2);
        assert_eq!(branch_unmerged_count(&r, "main").unwrap(), 0);

        // 删除未合入：-d 拒绝、-D 强删
        assert!(matches!(
            delete_branch(&r, "topic", false),
            Err(GitError::CommandFailed(_))
        ));
        assert!(r.run_ok(&["show-ref", "--verify", "--quiet", "refs/heads/topic"]));
        delete_branch(&r, "topic", true).unwrap();
        assert!(!r.run_ok(&["show-ref", "--verify", "--quiet", "refs/heads/topic"]));

        // 已合入分支 -d 直接删除成功
        create_branch(&r, "temp", false, None).unwrap();
        delete_branch(&r, "temp", false).unwrap();
        assert!(!r.run_ok(&["show-ref", "--verify", "--quiet", "refs/heads/temp"]));

        // 改名：成功 / 重名拦截
        create_branch(&r, "old-name", false, None).unwrap();
        rename_branch(&r, "old-name", "new-name").unwrap();
        assert!(r.run_ok(&["show-ref", "--verify", "--quiet", "refs/heads/new-name"]));
        assert!(matches!(
            rename_branch(&r, "new-name", "main"),
            Err(GitError::CommandFailed(m)) if m.contains("已存在")
        ));

        // 删除当前分支由 git 拦截
        assert!(matches!(
            delete_branch(&r, "main", true),
            Err(GitError::CommandFailed(_))
        ));
    }

    #[test]
    fn reset_branch_three_modes() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        commit_file(t.path(), "b.txt", "staged content", "second");
        fs::write(t.path().join("c.txt"), "untracked").unwrap();
        let r = GitRepo::open(t.path()).unwrap();
        let base = git(t.path(), &["rev-parse", "HEAD~1"]).trim().to_string();

        // 软重置：b 回到暂存区，工作区文件原样
        reset_branch(&r, &base, "soft").unwrap();
        let st = get_status(&r).unwrap();
        assert!(st.staged.iter().any(|f| f.path == "b.txt" && f.status == 'A'));
        assert_eq!(r.current_branch(), "main");

        // 非法哈希 / 非法模式被拦截
        assert!(matches!(
            reset_branch(&r, "zzzz", "soft"),
            Err(GitError::CommandFailed(m)) if m.contains("非法提交哈希")
        ));
        assert!(matches!(
            reset_branch(&r, &base, "bazooka"),
            Err(GitError::CommandFailed(m)) if m.contains("非法 reset 模式")
        ));

        // 混合重置：暂存区清空，改动退回工作区
        reset_branch(&r, &base, "mixed").unwrap();
        let st2 = get_status(&r).unwrap();
        assert!(st2.staged.is_empty());
        assert!(st2.unstaged.iter().any(|f| f.path == "b.txt"));

        // 硬重置：tracked 改动被丢弃，未跟踪文件保留（b.txt 重新暂存使其回到 index）
        stage(&r, &["b.txt".into()]).unwrap();
        reset_branch(&r, &base, "hard").unwrap();
        let st3 = get_status(&r).unwrap();
        assert!(st3.staged.is_empty() && st3.unstaged.iter().all(|f| f.path == "c.txt"));
        assert!(!t.path().join("b.txt").exists());
        assert!(t.path().join("c.txt").exists());
    }

    #[test]
    fn push_upstream_and_remote_list() {
        let (origin, work) = repo_with_origin();
        let r = GitRepo::open(work.path()).unwrap();
        assert_eq!(list_remotes(&r).unwrap(), vec!["origin".to_string()]);

        // 新分支没有上游 → push 报 NoUpstream；push_upstream 建立关联并推送
        create_branch(&r, "feat", true, None).unwrap();
        commit_file(work.path(), "f.txt", "1", "feat work");
        assert!(matches!(push(&r), Err(GitError::NoUpstream(_))));
        let msg = push_upstream(&r, "origin", "feat").unwrap();
        assert!(msg.contains("origin/feat"), "{msg}");
        let up = git(work.path(), &["rev-parse", "--abbrev-ref", "@{u}"]);
        assert_eq!(up.trim(), "origin/feat");

        // 空参数拒绝
        assert!(matches!(
            push_upstream(&r, " ", "feat"),
            Err(GitError::CommandFailed(_))
        ));
        let _ = origin;
    }

    #[test]
    fn merge_upstream_clean_conflict_and_abort() {
        // 干净合并：两边改不同文件
        let (origin, work) = repo_with_origin();
        let clone_dir = TempDir::new().unwrap();
        git(
            clone_dir.path(),
            &[
                "clone",
                "-q",
                origin.path().to_str().unwrap(),
                clone_dir.path().join("c2").to_str().unwrap(),
            ],
        );
        let c2 = clone_dir.path().join("c2");
        git(&c2, &["config", "user.email", "test@fumigit.dev"]);
        git(&c2, &["config", "user.name", "Fumi Test"]);
        commit_file(&c2, "remote.txt", "r1", "remote side");
        git(&c2, &["push", "-q", "origin", "main"]);

        commit_file(work.path(), "local.txt", "l1", "local side");
        let r = GitRepo::open(work.path()).unwrap();
        assert!(matches!(pull(&r), Err(GitError::NonFastForward(_))));

        let msg = merge_ref(&r, "origin/main").unwrap();
        assert!(msg.contains("Merge") || msg.contains("merge"), "{msg}");
        assert!(work.path().join("remote.txt").exists());
        let st = get_status(&r).unwrap();
        assert!(st.operation.is_none());
        assert!(st.unmerged.is_empty());

        // 冲突合并：两边改同一文件
        commit_file(work.path(), "a.txt", "local edit", "local edits a");
        commit_file(&c2, "a.txt", "remote edit", "remote edits a");
        git(&c2, &["push", "-q", "origin", "main"]);
        fetch(&r).unwrap();
        assert!(matches!(pull(&r), Err(GitError::NonFastForward(_))));
        assert!(merge_ref(&r, "origin/main").is_err());

        // 合并中：状态带 merging + 冲突清单
        let st = get_status(&r).unwrap();
        assert_eq!(st.operation, Some(Operation::Merge));
        assert!(st.unmerged.iter().any(|f| f.path == "a.txt" && f.status == 'U'));
        assert!(!st.staged.iter().any(|f| f.path == "a.txt"));
        assert!(!st.unstaged.iter().any(|f| f.path == "a.txt"));

        // 中止合并：完整回到合并前
        abort_operation(&r, Operation::Merge).unwrap();
        let st2 = get_status(&r).unwrap();
        assert!(st2.operation.is_none());
        assert!(st2.unmerged.is_empty());
        assert!(st2.staged.is_empty() && st2.unstaged.is_empty());
        let head = git(work.path(), &["rev-parse", "HEAD"]);
        assert!(git(work.path(), &["log", "--oneline", "-1", "HEAD"]).contains("local edits a"));
        assert_eq!(
            git(work.path(), &["rev-parse", "refs/heads/main"]),
            head
        );

        // 非合并状态中止 → 结构化报错
        assert!(matches!(
            abort_operation(&r, Operation::Merge),
            Err(GitError::CommandFailed(m)) if m.contains("没有进行中的对应操作")
        ));
        let _ = origin;
    }

    #[test]
    fn stash_lifecycle_list_diff_apply_drop() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        let r = GitRepo::open(t.path()).unwrap();

        // 两条 stash：最新在前
        fs::write(t.path().join("a.txt"), "wip1").unwrap();
        stash_push(&r, Some("第一条")).unwrap();
        fs::write(t.path().join("a.txt"), "wip2").unwrap();
        stash_push(&r, None).unwrap();

        let list = stash_list(&r).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[1].index, 1);
        assert!(list[1].message.contains("第一条"), "{}", list[1].message);
        assert!(list[0].time > 0);

        // 只读 diff：stash@{1} 是把 a.txt 改成 wip1 的改动
        let patch = stash_diff(&r, 1).unwrap();
        assert!(patch.contains("+wip1"), "{patch}");

        // apply 保留副本：工作区恢复且条目仍在
        stash_apply(&r, 1, false).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "wip1");
        assert_eq!(stash_list(&r).unwrap().len(), 2);

        // 冲突场景：先弄脏工作区再 pop 同一 stash → 报错且条目保留
        fs::write(t.path().join("a.txt"), "conflicting").unwrap();
        let before = stash_list(&r).unwrap().len();
        assert!(stash_apply(&r, 0, true).is_err());
        assert_eq!(stash_list(&r).unwrap().len(), before, "pop 冲突时条目必须保留");
        // 中止现场：还原工作区文件
        git(t.path(), &["checkout", "--", "a.txt"]);

        // pop 成功：条目移除
        stash_apply(&r, 1, true).unwrap();
        assert_eq!(stash_list(&r).unwrap().len(), before - 1);
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "wip1");

        // drop：确认后删除
        stash_drop(&r, 0).unwrap();
        assert_eq!(stash_list(&r).unwrap().len(), before - 2);
    }

    #[test]
    fn stash_diff_includes_untracked_files() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        let r = GitRepo::open(t.path()).unwrap();

        fs::write(t.path().join("a.txt"), "2").unwrap();
        fs::write(t.path().join("new.txt"), "untracked body").unwrap();
        stash_push(&r, None).unwrap();

        let patch = stash_diff(&r, 0).unwrap();
        assert!(patch.contains("+2"), "tracked part: {patch}");
        assert!(patch.contains("untracked body"), "untracked part: {patch}");
    }

    #[test]
    fn discard_worktree_staged_untracked_and_all() {
        let t = repo();
        commit_file(t.path(), "a.txt", "base\n", "init");
        commit_file(t.path(), "b.txt", "keep\n", "init b");
        let r = GitRepo::open(t.path()).unwrap();

        // 现场：a 未暂存修改 + b 暂存修改 + c 新暂存 + d 未跟踪
        fs::write(t.path().join("a.txt"), "dirty\n").unwrap();
        fs::write(t.path().join("b.txt"), "staged edit\n").unwrap();
        stage(&r, &["b.txt".into()]).unwrap();
        fs::write(t.path().join("c.txt"), "new file\n").unwrap();
        stage(&r, &["c.txt".into()]).unwrap();
        fs::write(t.path().join("d.txt"), "untracked\n").unwrap();

        // 未暂存丢弃：a 从 index 恢复
        discard_worktree(&r, &["a.txt".into()]).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "base\n");

        // 未跟踪删除
        delete_untracked(&r, &["d.txt".into()]).unwrap();
        assert!(!t.path().join("d.txt").exists());

        // 已暂存丢弃（M）：b 回到 HEAD
        discard_staged(&r, &["b.txt".into()]).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("b.txt")).unwrap(), "keep\n");

        // 已暂存新增丢弃：c 从 index 与磁盘同时消失
        discard_staged_new(&r, &["c.txt".into()]).unwrap();
        assert!(!t.path().join("c.txt").exists());
        let st = get_status(&r).unwrap();
        assert!(st.staged.is_empty() && st.unstaged.is_empty());

        // 全部丢弃：tracked + 未跟踪一起清场
        fs::write(t.path().join("a.txt"), "dirty again\n").unwrap();
        fs::write(t.path().join("e.txt"), "untracked\n").unwrap();
        fs::create_dir_all(t.path().join("sub")).unwrap();
        fs::write(t.path().join("sub").join("f.txt"), "u\n").unwrap();
        stage(&r, &["a.txt".into()]).unwrap();
        discard_all(&r).unwrap();
        let st2 = get_status(&r).unwrap();
        assert!(st2.staged.is_empty() && st2.unstaged.is_empty());
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "base\n");
        assert!(!t.path().join("e.txt").exists());
        assert!(!t.path().join("sub").exists());
    }

    #[test]
    fn resolve_take_continue_and_read_worktree_file() {
        let t = repo();
        commit_file(t.path(), "a.txt", "base\n", "base");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        commit_file(t.path(), "a.txt", "feat\n", "feat side");
        commit_file(t.path(), "f.txt", "feat work\n", "feat work");
        git(t.path(), &["checkout", "-q", "main"]);
        commit_file(t.path(), "a.txt", "main\n", "main side");
        let feat_tip = git(t.path(), &["rev-parse", "feat"]).trim().to_string();
        // 制造 merge 冲突（夹具命令允许失败）
        let out = Command::new("git")
            .current_dir(t.path())
            .args(["merge", "--no-ff", &feat_tip])
            .output()
            .unwrap();
        assert!(!out.status.success(), "夹具必须真冲突");
        let r = GitRepo::open(t.path()).unwrap();
        assert!(get_status(&r).unwrap().unmerged.iter().any(|f| f.path == "a.txt"));

        // 冲突未解决时 continue 被拒
        assert!(matches!(
            continue_operation(&r, Operation::Merge),
            Err(GitError::CommandFailed(m)) if m.contains("冲突文件未解决")
        ));

        // 选边（我方）：内容恢复为 main 侧并直接进入已暂存
        resolve_take(&r, "a.txt", true).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "main\n");
        let st = get_status(&r).unwrap();
        assert!(st.unmerged.is_empty()); // 我方版本与 HEAD 一致，无差异即无暂存条目
        // 继续合并 → 产生合并提交
        continue_operation(&r, Operation::Merge).unwrap();
        let page = get_log(&r, 0, 3).unwrap();
        assert_eq!(page.commits[0].parents.len(), 2);
        assert!(get_status(&r).unwrap().operation.is_none());

        // read_worktree_file：原文与穿越守卫
        assert_eq!(read_worktree_file(&r, "f.txt").unwrap(), "feat work\n");
        assert!(matches!(
            read_worktree_file(&r, "../escape"),
            Err(GitError::CommandFailed(m)) if m.contains("非法文件路径")
        ));
        assert!(matches!(
            read_worktree_file(&r, "no-such.txt"),
            Err(GitError::CommandFailed(m)) if m.contains("文件不存在")
        ));

        // 选边（对方）单文件场景
        let t2 = repo();
        commit_file(t2.path(), "a.txt", "base\n", "base");
        git(t2.path(), &["checkout", "-q", "-b", "feat"]);
        commit_file(t2.path(), "a.txt", "feat\n", "feat side");
        git(t2.path(), &["checkout", "-q", "main"]);
        commit_file(t2.path(), "a.txt", "main\n", "main side");
        let feat_tip2 = git(t2.path(), &["rev-parse", "feat"]).trim().to_string();
        let out2 = Command::new("git")
            .current_dir(t2.path())
            .args(["merge", "--no-ff", &feat_tip2])
            .output()
            .unwrap();
        assert!(!out2.status.success(), "夹具必须真冲突");
        let r2 = GitRepo::open(t2.path()).unwrap();
        resolve_take(&r2, "a.txt", false).unwrap();
        assert_eq!(fs::read_to_string(t2.path().join("a.txt")).unwrap(), "feat\n");
    }

    /// 票 08 性能 smoke（默认忽略，显式运行：cargo test perf_100k -- --ignored）
    /// 用 fast-import 生成 10 万提交 + 分支合并夹具，测分页日志全量走完的耗时。
    #[test]
    #[ignore]
    fn perf_100k_log_smoke() {
        let t = TempDir::new().unwrap();
        let dir = t.path();
        let count = 100_000;
        git(dir, &["init", "-q", "-b", "main"]);
        let mut stream = String::with_capacity(count * 160);
        stream.push_str("reset refs/heads/main\n");
        for i in 1..=3 {
            stream.push_str(&format!("blob\nmark :{i}\ndata 16\ncontent v{i} pad\n\n"));
        }
        let mut ts: i64 = 1_600_000_000;
        let mut mark = 10usize;
        for i in 1..=count {
            ts += 60;
            let branch = if i % 97 == 0 { "refs/heads/side" } else { "refs/heads/main" };
            stream.push_str(&format!(
                "commit {branch}\nmark :{mark}\nauthor P <p@p> {ts} +0000\ncommitter P <p@p> {ts} +0000\ndata 11\nmsg {mark:07}\nM 100644 :{} a.txt\n\n",
                mark % 3 + 1
            ));
            mark += 1;
        }
        fs::write(dir.join("in.stream"), &stream).unwrap();
        let out = Command::new("git")
            .current_dir(dir)
            .args(["fast-import", "--quiet"])
            .stdin(fs::File::open(dir.join("in.stream")).unwrap())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "fast-import 失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let repo = GitRepo::open(dir).unwrap();
        let started = std::time::Instant::now();
        let first = get_log(&repo, 0, 200).unwrap();
        let first_elapsed = started.elapsed();
        assert_eq!(first.commits.len(), 200);
        assert!(!first.done);

        let mut total = 0usize;
        let mut skip = 0usize;
        let all = std::time::Instant::now();
        loop {
            let page = get_log(&repo, skip, 200).unwrap();
            total += page.commits.len();
            if page.done {
                break;
            }
            skip += 200;
            if skip > count + 1000 {
                panic!("分页未在合理范围内结束");
            }
        }
        let all_elapsed = all.elapsed();
        assert!(total >= count);
        println!("首 200 条: {first_elapsed:?}；全量 {total} 条（{} 页）: {all_elapsed:?}", skip / 200 + 1);
    }

    #[test]
    fn operation_detection_and_conflict_versions() {
        let t = repo();
        commit_file(t.path(), "a.txt", "base\n", "base");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        commit_file(t.path(), "a.txt", "feat\n", "feat side");
        git(t.path(), &["checkout", "-q", "main"]);
        commit_file(t.path(), "a.txt", "main\n", "main side");
        let r = GitRepo::open(t.path()).unwrap();
        assert!(get_status(&r).unwrap().operation.is_none());

        // cherry-pick 冲突 → CHERRY_PICK_HEAD → operation = cherry-pick
        let feat_tip = git(t.path(), &["rev-parse", "feat"]).trim().to_string();
        let out = Command::new("git")
            .current_dir(t.path())
            .args(["cherry-pick", &feat_tip])
            .output()
            .unwrap();
        assert!(!out.status.success(), "夹具必须真冲突");
        let st = get_status(&r).unwrap();
        assert_eq!(st.operation, Some(Operation::CherryPick));
        assert!(st.unmerged.iter().any(|f| f.path == "a.txt"));

        // stages 三方内容
        let v = conflict_versions(&r, "a.txt").unwrap();
        assert_eq!(v.base.as_deref(), Some("base\n"));
        assert_eq!(v.ours.as_deref(), Some("main\n"));
        assert_eq!(v.theirs.as_deref(), Some("feat\n"));
        // 非法路径拒绝
        assert!(matches!(
            conflict_versions(&r, "../escape"),
            Err(GitError::CommandFailed(m)) if m.contains("非法文件路径")
        ));

        abort_operation(&r, Operation::CherryPick).unwrap();
        assert!(get_status(&r).unwrap().operation.is_none());

        // revert 冲突 → REVERT_HEAD → operation = revert；abort 只认对应操作
        let out = Command::new("git")
            .current_dir(t.path())
            .args(["revert", "--no-edit", &feat_tip])
            .output()
            .unwrap();
        assert!(!out.status.success(), "夹具必须真冲突");
        let st2 = get_status(&r).unwrap();
        assert_eq!(st2.operation, Some(Operation::Revert));
        assert!(matches!(
            abort_operation(&r, Operation::CherryPick),
            Err(GitError::CommandFailed(_))
        ));
        abort_operation(&r, Operation::Revert).unwrap();
        assert!(get_status(&r).unwrap().operation.is_none());
    }
}

