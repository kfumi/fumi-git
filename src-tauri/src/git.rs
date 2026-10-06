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
    pub branch: String,
}

pub fn get_status(repo: &GitRepo) -> GitResult<RepoStatus> {
    let raw = repo.run(&["status", "--porcelain", "-z"])?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
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
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::CommandFailed("分支名为空".into()));
    }
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
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::CommandFailed("分支名为空".into()));
    }
    let flag = if force { "-D" } else { "-d" };
    repo.run(&["branch", flag, name])?;
    Ok(())
}

/// 分支上尚未合入当前 HEAD 的提交数（0 = 已合入）。供删除前的防丢确认。
pub fn branch_unmerged_count(repo: &GitRepo, name: &str) -> GitResult<u32> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::CommandFailed("分支名为空".into()));
    }
    let out = repo.run(&["rev-list", "--count", &format!("HEAD..{name}")])?;
    out.trim()
        .parse()
        .map_err(|_| GitError::CommandFailed(format!("无法解析提交计数：{out}")))
}

/// 分支改名（old 不存在 / new 非法或已存在时由预检或 git 拦截）。
pub fn rename_branch(repo: &GitRepo, old: &str, new: &str) -> GitResult<()> {
    let old = old.trim();
    if old.is_empty() {
        return Err(GitError::CommandFailed("分支名为空".into()));
    }
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
                    "本地与远程历史分叉，无法快进。请在终端处理（rebase/merge）后重试".into(),
                ))
            } else {
                Err(GitError::CommandFailed(stderr))
            }
        }
        Err(e) => Err(e),
    }
}

pub fn push(repo: &GitRepo) -> GitResult<String> {
    let upstream = repo.run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if upstream.is_err() {
        let branch = repo.current_branch();
        return Err(GitError::NoUpstream(format!(
            "分支 {branch} 还没有上游分支。请在终端执行 git push -u <远程> {branch} 建立关联"
        )));
    }
    match repo.run(&["push"]) {
        Ok(_) => Ok("推送完成".into()),
        Err(GitError::CommandFailed(stderr)) => {
            let s = stderr.to_lowercase();
            if s.contains("non-fast-forward") || s.contains("rejected") || s.contains("fetch first") {
                Err(GitError::NonFastForward(
                    "推送被拒：远程有本地没有的提交。请先拉取（无法快进时需在终端处理历史）".into(),
                ))
            } else {
                Err(GitError::CommandFailed(stderr))
            }
        }
        Err(e) => Err(e),
    }
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
}

