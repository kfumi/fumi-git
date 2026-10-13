//! git CLI 封装层 —— 唯一的 Git 后端（ADR：禁止引入 libgit2/gitoxide 作为行为源）。
//!
//! 所有 Git 读写都经过这里 spawn 真实 git 进程、解析 porcelain 输出，
//! 由此免费继承用户的 gitconfig、hooks、credential helper 与 SSH agent。
//! 测试使用真实 git 在临时目录构造夹具仓库，不 mock git 本身。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

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

/// Windows release 构建本进程是 GUI 子系统（main.rs 的 windows_subsystem），没有控制台。
/// 此时 CreateProcess 会给每个 git.exe 新分配一个控制台窗口 —— 打开仓库时几十条命令就会
/// 闪几十个黑框。CREATE_NO_WINDOW 让子进程无窗口运行；stdout/stderr 本来就管道化，
/// 不依赖控制台，所以无副作用。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
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
    /// `rev-parse --show-toplevel` 归一化的仓库根
    pub root: PathBuf,
    /// `rev-parse --absolute-git-dir`：MERGE_HEAD / rebase-merge 等中间态的锚点。
    /// linked worktree 下 `.git` 是**文件**而不是目录，所以必须问 git 要，不能硬拼 root/.git。
    pub gitdir: PathBuf,
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
        // 一次调用拿两行：仓库根 + gitdir（子目录打开也正确；`--absolute-git-dir` 自 git 2.13 起可用）
        let out = spawn_git(
            Some(dir),
            &["rev-parse", "--show-toplevel", "--absolute-git-dir"],
            None,
        )?;
        if out.success {
            let mut lines = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty());
            let root = lines
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| GitError::NotARepo("无法解析仓库根目录".into()))?;
            let gitdir = lines
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(".git"));
            return Ok(GitRepo { root, gitdir });
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

/// 日志侧筛选（前端「分支 / 提交者 / 日期」三块下拉）。
///
/// 刻意下推到 git 而不是客户端过滤：`--skip` / `--max-count` / `done` 全都在**过滤后**的
/// 集合上算，分页与空态才不会骗人；分支筛选顶掉 `--all`，并发 lane 随之收窄。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LogFilter {
    /// 本地分支短名（后端按 `refs/heads/<name>` 校验后使用）；None = 所有分支（`--all`）
    #[serde(default)]
    pub branch: Option<String>,
    /// 提交者子串（姓名或邮箱，固定串匹配）；None = 不限
    #[serde(default)]
    pub author: Option<String>,
    /// 时间范围白名单：day / week / month；None = 全部时间
    #[serde(default)]
    pub since: Option<String>,
}

impl LogFilter {
    fn branch(&self) -> Option<&str> {
        self.branch.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    fn author(&self) -> Option<&str> {
        self.author.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    fn since(&self) -> Option<&str> {
        self.since.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
}

/// 时间范围白名单 → git 能解析的时间串（前端只传档位，不接受任意日期表达式）。
fn since_spec(range: &str) -> GitResult<&'static str> {
    match range {
        "day" => Ok("24 hours ago"),
        "week" => Ok("7 days ago"),
        "month" => Ok("1 month ago"),
        other => Err(GitError::CommandFailed(format!("非法时间范围：{other}"))),
    }
}

/// 分支筛选的 ref 解析：先拒绝空值与以 `-` 开头的值（否则会被当成 git 选项），
/// 再按 `refs/heads/<name>` 校验存在——用全名而非短名，避开与同名标签的歧义。
fn resolve_branch_ref(repo: &GitRepo, name: &str) -> GitResult<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err(GitError::CommandFailed(format!("非法分支名：{name}")));
    }
    let full = format!("refs/heads/{name}");
    if !repo.run_ok(&["rev-parse", "--verify", "--quiet", &format!("{full}^{{commit}}")]) {
        return Err(GitError::CommandFailed(format!("分支不存在：{name}")));
    }
    Ok(full)
}

/// 拓扑序提交日志（children 恒排在 parent 之前），供前端建图。
/// 无筛选 = 全分支 `--all`（FumiGit 的默认并发展示）；带筛选则收窄到对应子集。
pub fn get_log_filtered(
    repo: &GitRepo,
    skip: usize,
    limit: usize,
    filter: &LogFilter,
) -> GitResult<LogPage> {
    let skip_s = skip.to_string();
    let count = limit.to_string();
    let mut args: Vec<String> = vec![
        "log".to_string(),
        "--topo-order".to_string(),
        format!("--skip={skip_s}"),
        format!("--max-count={count}"),
        format!("--format={LOG_FORMAT}"),
    ];
    // `--author` 默认按正则解释（`a.b` 会连 `axb` 一起命中），必须固定串匹配
    if let Some(a) = filter.author() {
        args.push("--fixed-strings".to_string());
        args.push(format!("--author={a}"));
    }
    if let Some(r) = filter.since() {
        args.push(format!("--since={}", since_spec(r)?));
    }
    // 版本范围放最后（git 的 revision 参数位）
    match filter.branch() {
        Some(b) => args.push(resolve_branch_ref(repo, b)?),
        None => args.push("--all".to_string()),
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = repo.run(&argv)?;
    let commits = parse_log_output(&raw);
    let done = commits.len() < limit;
    Ok(LogPage { commits, done })
}

// ── 提交身份 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct UserIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// 本仓库解析出的提交身份（`user.name` / `user.email`，含全局配置继承），
/// 供「只看我的」筛选。未配置的项为 None，前端据此禁用该入口。
pub fn get_user_identity(repo: &GitRepo) -> UserIdentity {
    let get = |key: &str| {
        repo.run(&["config", "--get", "--default=", key])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    UserIdentity {
        name: get("user.name"),
        email: get("user.email"),
    }
}

// ── 引用列表 ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefEntry {
    /// 短名：本地分支 `main`、远程 ref `origin/main`、标签 `v1.0.0`
    pub name: String,
    pub kind: RefKind,
    /// tip 提交 id；附注标签已剥离到它所标注的提交
    pub tip: String,
    /// 创建时间（unix 秒；标签按此倒序）
    pub time: u32,
    /// 上游分支短名（如 `origin/main`）；远程 ref 与标签天然为空 → None
    pub upstream: Option<String>,
}

/// refname / objectname / 剥离后的 objectname / symref / 创建时间 / 上游短名
const REF_FORMAT: &str =
    "%(refname)%1f%(objectname)%1f%(*objectname)%1f%(symref)%1f%(creatordate:unix)%1f%(upstream:short)";

/// 全量引用（本地分支 / 远程分支 / 标签）。
///
/// 刻意与 `get_log` 的分页解耦：`get_log` 只在**已加载提交**的行上给 ref 装饰，
/// 侧栏若从提交推导引用，tip 落在分页窗口之外的老分支/老标签就整个不存在。
pub fn list_refs(repo: &GitRepo) -> GitResult<Vec<RefEntry>> {
    let raw = repo.run(&[
        "for-each-ref",
        &format!("--format={REF_FORMAT}"),
        "refs/heads",
        "refs/tags",
        "refs/remotes",
    ])?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut f = line.split('\u{1f}');
        let full = f.next().unwrap_or_default();
        let objname = f.next().unwrap_or_default();
        let peeled = f.next().unwrap_or_default();
        let symref = f.next().unwrap_or_default();
        let time = f.next().unwrap_or_default();
        let upstream = f.next().unwrap_or_default();

        // 符号 ref（refs/remotes/<remote>/HEAD）只是指针，不是真实分支
        if full.is_empty() || !symref.is_empty() {
            continue;
        }
        // 附注标签的 objectname 是 tag 对象，须剥离到所标注的提交
        let tip = if peeled.is_empty() { objname } else { peeled };
        if tip.is_empty() {
            continue;
        }
        let (name, kind) = if let Some(n) = full.strip_prefix("refs/heads/") {
            (n, RefKind::Branch)
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            (n, RefKind::Remote)
        } else if let Some(n) = full.strip_prefix("refs/tags/") {
            (n, RefKind::Tag)
        } else {
            continue;
        };
        out.push(RefEntry {
            name: name.to_string(),
            kind,
            tip: tip.to_string(),
            time: time.parse().unwrap_or(0),
            upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
        });
    }
    Ok(out)
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

/// 提交详情：LOG_FORMAT 的 8 个字段 + body（body 放最后一格，用 `split_once` 切，
/// 正文里出现分隔符也不会被切开）。
const DETAIL_FORMAT: &str = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e%x1f%b";

/// `show -s --format=DETAIL_FORMAT` → (元信息, body)；元信息复用 `get_log` 的解析。
fn parse_detail_head(raw: &str) -> GitResult<(CommitEntry, String)> {
    let (meta_part, rest) = raw
        .split_once('\u{1e}')
        .ok_or_else(|| GitError::CommandFailed("提交详情格式异常".into()))?;
    let meta = parse_log_output(&format!("{meta_part}\u{1e}"))
        .pop()
        .ok_or_else(|| GitError::CommandFailed("提交不存在".into()))?;
    let body = rest
        .strip_prefix('\u{1f}')
        .unwrap_or(rest)
        .trim()
        .to_string();
    Ok((meta, body))
}

/// `--format= --raw --numstat [--patch] -M` 的输出 → (files, patch)
///
/// 段序（实测）：`:` 开头的 raw 段 → numstat 段 → （可选）patch 段，`git diff` 同序。
/// `--raw` 的记录形态：`:oldmode newmode oldsha newsha <STATUS>\t<path>`，重命名是
/// `R100\t<source>\t<destination>`（源在前、目标在后 —— 同一个 diff 的 patch 段里
/// 写着 `rename from <source> / rename to <destination>`），而 numstat 的重命名形态是
/// `0\t0\t<source> => <destination>`（目标也在后，与 raw 同向），既有 `parse_numstat`
/// 两种形态都能处理。
///
/// 所以按**目标路径**建索引：先用 numstat 定文件顺序与计数，再用 raw 覆盖权威
/// status / 原路径。patch 段在最后，按首个 `diff --git` 行切出 —— hunk 正文行首
/// 只会是 ` `、`+`、`-`、`@`、`\` 或 diff 头，因此正文里以 `:` 开头的行不会被
/// 误当成 raw 段。
fn parse_show_raw_numstat_patch(raw: &str) -> (Vec<FileStat>, Option<String>) {
    let patch_at = raw.lines().position(|l| l.starts_with("diff --git "));
    let (body, patch) = match patch_at {
        Some(i) => {
            let mut it = raw.lines();
            let head: Vec<&str> = it.by_ref().take(i).collect();
            (
                head.join("\n"),
                Some(raw.lines().skip(i).collect::<Vec<_>>().join("\n")),
            )
        }
        None => (raw.to_string(), None),
    };
    let numstat_part: String = body
        .lines()
        .filter(|l| !l.starts_with(':'))
        .collect::<Vec<_>>()
        .join("\n");
    let mut files = parse_numstat(&numstat_part);
    // `--raw` 是权威：status 字母 + 重命名的原路径
    let mut raw_map = std::collections::HashMap::new();
    for line in body.lines().filter(|l| l.starts_with(':')) {
        let (meta, paths) = match line[1..].split_once('\t') {
            Some(v) => v,
            None => continue,
        };
        let status = meta
            .rsplit(' ')
            .next()
            .and_then(|s| s.chars().next())
            .unwrap_or('M');
        // 单路径记录只有一段；重命名 / 拷贝是 `<source>\t<destination>`
        let (old_path, new_path) = match paths.split_once('\t') {
            Some((src, dst)) => (Some(src.to_string()), dst.to_string()),
            None => (None, paths.to_string()),
        };
        raw_map.insert(new_path, (status, old_path));
    }
    for f in &mut files {
        if let Some((st, old)) = raw_map.get(&f.path) {
            f.status = *st;
            if old.is_some() {
                f.old_path = old.clone();
            }
        }
    }
    (files, patch)
}

/// 读取单条提交的元信息（与 `get_log` 共用日志格式与解析，供详情与比较复用）。
fn commit_meta(repo: &GitRepo, hash: &str) -> GitResult<CommitEntry> {
    let raw = repo.run(&[
        "show",
        "-s",
        &format!("--format={LOG_FORMAT}"),
        hash,
    ])?;
    parse_log_output(&raw)
        .pop()
        .ok_or_else(|| GitError::CommandFailed("提交不存在".into()))
}

pub fn get_commit_detail(repo: &GitRepo, hash: &str) -> GitResult<CommitDetail> {
    let safe = hash.trim();
    if safe.is_empty() || !safe.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::CommandFailed("非法提交哈希".into()));
    }
    // 元信息 + 正文：一次 show 拿全（DETAIL_FORMAT 的 8 个字段 + body）
    let meta_raw = repo.run(&["show", "-s", &format!("--format={DETAIL_FORMAT}"), safe])?;
    let (meta, body) = parse_detail_head(&meta_raw)?;
    // 文件统计 + patch 合成一次输出（--raw 权威 status/原路径，numstat 给计数）。
    // 合并提交不产出 patch（保持现状语义：patch = None），因此连 --patch 都不传。
    let is_merge = meta.parents.len() > 1;
    let mut args: Vec<&str> = vec!["show", "--format=", "--raw", "--numstat", "-M"];
    if !is_merge {
        args.push("--patch");
    }
    args.push(safe);
    let raw = repo.run(&args)?;
    let (files, patch) = parse_show_raw_numstat_patch(&raw);
    // 非合并提交即使无文件变更也与改造前同形（patch = Some("")）：只有合并提交是 None，
    // 前端据此渲染「合并提交 — 无直接文件变更」文案
    let patch = match patch {
        Some(p) => Some(p),
        None if !is_merge => Some(String::new()),
        None => None,
    };
    Ok(CommitDetail {
        meta,
        body,
        files,
        patch,
    })
}

/// 两个提交的比较结果：`base..head` 的元信息、文件统计与统一 diff。
#[derive(Debug, Clone, Serialize)]
pub struct CompareResult {
    pub base: CommitEntry,
    pub head: CommitEntry,
    pub files: Vec<FileStat>,
    /// 统一 diff 原文；无差异（patch 为空）为 None
    pub patch: Option<String>,
}

/// 比较任意两个提交（不限于 HEAD）。两端接受十六进制提交 id；`HEAD` / `@` 按调用瞬间的 HEAD 解析
/// （右栏「与 HEAD 比较」的 base 就是字面量 `HEAD`，这样基准永远是当前 HEAD 而不是某个旧 id）。
pub fn get_compare(repo: &GitRepo, base: &str, head: &str) -> GitResult<CompareResult> {
    let base = resolve_compare_ref(repo, base)?;
    let head = resolve_compare_ref(repo, head)?;
    let range = format!("{base}..{head}");
    // 统计 + 权威 status + patch 一次拿全（`diff` 与 `show` 段序一致：raw → numstat → patch；
    // 无差异时整段输出为空 → patch: None，与改造前同形）
    let raw = repo.run(&["diff", "--raw", "--numstat", "--patch", &range])?;
    let (files, patch) = parse_show_raw_numstat_patch(&raw);
    Ok(CompareResult {
        base: commit_meta(repo, &base)?,
        head: commit_meta(repo, &head)?,
        files,
        patch,
    })
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

/// `status --porcelain=v2 --branch` 头部里我们用得到的两项。
pub(crate) struct StatusHeads {
    /// `# branch.head`：常规分支为分支名，分离 HEAD 为 `(detached)`，缺失为 None
    pub head: Option<String>,
    /// `# branch.upstream`：只在有效上游时出现
    pub upstream: Option<String>,
}

/// `# branch.ab +N -M` → (ahead, behind)；无有效上游时该行不出现 → None。
fn parse_branch_ab(raw: &str) -> Option<(u32, u32)> {
    for rec in raw.split('\0') {
        if let Some(rest) = rec.strip_prefix("# branch.ab ") {
            // 形如 `+1 -0`
            let mut it = rest.split_whitespace();
            let a = it.next()?.trim_start_matches('+').parse().ok()?;
            let b = it.next()?.trim_start_matches('-').parse().ok()?;
            return Some((a, b));
        }
    }
    None
}

/// `status --porcelain=v2 --branch -z` → (staged, unstaged, unmerged, heads)
///
/// 记录形态（实测）：
///   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
///   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` + NUL + 原路径
///   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
///   `? <path>` / `! <path>` / `# branch.*`
fn parse_status_v2(raw: &str) -> (Vec<FileEntry>, Vec<FileEntry>, Vec<FileEntry>, StatusHeads) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut unmerged = Vec::new();
    let mut heads = StatusHeads {
        head: None,
        upstream: None,
    };
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(rec) = it.next() {
        if let Some(name) = rec.strip_prefix("# branch.head ") {
            heads.head = Some(name.trim().to_string());
            continue;
        }
        if let Some(up) = rec.strip_prefix("# branch.upstream ") {
            heads.upstream = Some(up.trim().to_string());
            continue;
        }
        if rec.starts_with("# branch.") {
            continue; // branch.oid / branch.ab 等
        }
        let tag = rec.chars().next().unwrap_or(' ');
        // XY 两字符：X = index 侧，Y = worktree 侧，'.' 表示未修改
        let xy_at = match tag {
            '1' | '2' | 'u' => 2usize,
            '?' | '!' => {
                if tag == '!' {
                    continue; // 未传 --ignored 不会出现；出现即忽略
                }
                let path = rec[2..].to_string();
                unstaged.push(FileEntry {
                    path,
                    old_path: None,
                    status: 'A',
                });
                continue;
            }
            _ => continue,
        };
        let mut chars = rec[xy_at..].chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        // 路径按字段宽度切（path 可能含空格）：1 记录 9 段、2 记录 10 段、u 记录 11 段
        let arity = match tag {
            '1' => 9,
            '2' => 10,
            _ => 11,
        };
        let mut f = rec.splitn(arity, ' ');
        for _ in 0..arity - 1 {
            f.next();
        }
        let path = f.next().unwrap_or_default().to_string();
        if path.is_empty() {
            continue;
        }
        // 重命名：紧随其后的 NUL 段是原路径（与既有 v1 解析同构）
        let old_path = if tag == '2' && (x == 'R' || x == 'C' || y == 'R' || y == 'C') {
            it.next().map(|s| s.to_string())
        } else {
            None
        };
        if tag == 'u' {
            unmerged.push(FileEntry {
                path,
                old_path,
                status: 'U',
            });
            continue;
        }
        if x != '.' {
            staged.push(FileEntry {
                path: path.clone(),
                old_path: old_path.clone(),
                status: x,
            });
        }
        if y != '.' {
            unstaged.push(FileEntry {
                path,
                old_path,
                status: y,
            });
        }
    }
    (staged, unstaged, unmerged, heads)
}

/// `# branch.head` → 与改造前 `current_branch()` 逐字相同的 `branch` 字符串。
fn branch_from_heads(repo: &GitRepo, heads: &StatusHeads) -> String {
    match heads.head.as_deref() {
        // 分离 HEAD：`<short>` 的长度由 git 的 core.abbrev 决定，不能自己截 oid，回退问一次 git
        Some("(detached)") => repo
            .run(&["rev-parse", "--short", "HEAD"])
            .map(|h| format!("(HEAD detached at {})", h.trim()))
            .unwrap_or_else(|_| "(空仓库)".to_string()),
        Some(name) => name.to_string(),
        None => repo.current_branch(),
    }
}

pub fn get_status(repo: &GitRepo) -> GitResult<RepoStatus> {
    // 一次调用拿全：三组文件 + 分支头 + 上游（+ ahead/behind）
    let raw = repo.run(&["status", "--porcelain=v2", "--branch", "-z"])?;
    let (staged, unstaged, unmerged, heads) = parse_status_v2(&raw);
    Ok(RepoStatus {
        staged,
        unstaged,
        unmerged,
        operation: read_operation(repo),
        branch: branch_from_heads(repo, &heads),
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

/// 建立分支与上游的关联（`--set-upstream-to`）。
/// upstream 形如 `origin/main`，含 `/` 属正常，不做分支名级校验。
pub fn set_upstream(repo: &GitRepo, branch: &str, upstream: &str) -> GitResult<()> {
    let branch = branch.trim();
    let upstream = upstream.trim();
    if branch.is_empty() || upstream.is_empty() {
        return Err(GitError::CommandFailed("分支或上游为空".into()));
    }
    repo.run(&["branch", &format!("--set-upstream-to={upstream}"), branch])?;
    Ok(())
}

/// 解除分支的上游关联（`--unset-upstream`）。
pub fn unset_upstream(repo: &GitRepo, branch: &str) -> GitResult<()> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(GitError::CommandFailed("分支名为空".into()));
    }
    repo.run(&["branch", "--unset-upstream", branch])?;
    Ok(())
}

/// 新建标签：message 非空 → 附注标签（`-a`），否则轻量标签。target 只接受提交哈希。
pub fn create_tag(repo: &GitRepo, name: &str, target: &str, message: Option<&str>) -> GitResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GitError::CommandFailed("标签名不能为空".into()));
    }
    let target = validate_hash(target)?;
    match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => repo.run(&["tag", "-a", name, &target, "-m", m])?,
        None => repo.run(&["tag", name, &target])?,
    };
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


/// 进行中的多提交操作（决定横幅文案与 abort 路由）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum Operation {
    #[serde(rename = "merge")]
    Merge,
    #[serde(rename = "cherry-pick")]
    CherryPick,
    #[serde(rename = "revert")]
    Revert,
    #[serde(rename = "rebase")]
    Rebase,
}

impl Operation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Operation::Merge => "merge",
            Operation::CherryPick => "cherry-pick",
            Operation::Revert => "revert",
            Operation::Rebase => "rebase",
        }
    }
}

/// 依据 sequencer 状态目录 / 文件识别进行中的操作（互斥，优先级即检出顺序）。
/// 变基优先级最高：变基中途 HEAD 处于分离态，其它探测可能误判。
///
/// 全部按文件判定：`gitdir` 已在 `open()` 里由 `--absolute-git-dir` 解析为绝对路径，
/// 对 MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / rebase-merge / rebase-apply
/// 这五个名字，`<gitdir>/<name>` 与 `rev-parse --git-path <name>` 解析到同一处
/// （linked worktree 下 gitdir 就是 `.git/worktrees/<name>` 这个 per-worktree 目录）。
fn read_operation(repo: &GitRepo) -> Option<Operation> {
    let g = &repo.gitdir;
    if g.join("rebase-merge").is_dir() || g.join("rebase-apply").is_dir() {
        return Some(Operation::Rebase);
    }
    let heads = [
        ("MERGE_HEAD", Operation::Merge),
        ("CHERRY_PICK_HEAD", Operation::CherryPick),
        ("REVERT_HEAD", Operation::Revert),
    ];
    for (name, op) in heads {
        if g.join(name).exists() {
            return Some(op);
        }
    }
    None
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

/// 中止进行中的操作（merge / cherry-pick / revert / rebase --abort），
/// 恢复到操作前状态。仅在对应操作进行中可用。
pub fn abort_operation(repo: &GitRepo, op: Operation) -> GitResult<()> {
    let current = read_operation(repo);
    if current != Some(op) {
        return Err(GitError::CommandFailed("当前没有进行中的对应操作".into()));
    }
    let cmd = op.as_str();
    repo.run(&["-c", "core.editor=true", cmd, "--abort"])?;
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
    let path = validate_repo_path(path)?;
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

/// 完成 / 跳过进行中的操作。
/// action = None / "continue"：`--continue`（冲突未清空时拒绝）；
/// action = "skip"：仅变基支持，丢弃当前提交继续；
/// 以内置空 editor 运行，沿用 git 生成的默认提交信息，不弹交互编辑器。
pub fn continue_operation(
    repo: &GitRepo,
    op: Operation,
    action: Option<&str>,
) -> GitResult<String> {
    let current = read_operation(repo);
    if current != Some(op) {
        return Err(GitError::CommandFailed("当前没有进行中的对应操作".into()));
    }
    match action.map(str::trim).filter(|a| !a.is_empty()) {
        None | Some("continue") => {
            let st = get_status(repo)?;
            if !st.unmerged.is_empty() {
                return Err(GitError::CommandFailed(format!(
                    "还有 {} 个冲突文件未解决",
                    st.unmerged.len()
                )));
            }
            repo.run(&["-c", "core.editor=true", op.as_str(), "--continue"])?;
            Ok("已完成".into())
        }
        Some("skip") => {
            if op != Operation::Rebase {
                return Err(GitError::CommandFailed("该操作不支持跳过".into()));
            }
            repo.run(&["-c", "core.editor=true", "rebase", "--skip"])?;
            Ok("已跳过本次提交".into())
        }
        Some(_) => Err(GitError::CommandFailed("非法动作".into())),
    }
}

// ── 历史修正：revert / cherry-pick（二阶段票 04/05） ────────────────────────

fn validate_hash(hash: &str) -> GitResult<String> {
    let hash = hash.trim();
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::CommandFailed("非法提交哈希".into()));
    }
    Ok(hash.to_string())
}

/// 比较入口的 ref 解析：`HEAD` / `@`（大小写不敏感）解析为当前 HEAD 的提交 id，其余按提交 id 校验。
fn resolve_compare_ref(repo: &GitRepo, value: &str) -> GitResult<String> {
    let v = value.trim();
    if v.eq_ignore_ascii_case("HEAD") || v == "@" {
        return Ok(repo.run(&["rev-parse", "HEAD"])?.trim().to_string());
    }
    validate_hash(v)
}

/// 检出指定修订（分离 HEAD）。target 只接受十六进制提交 id。
pub fn checkout_commit(repo: &GitRepo, hash: &str) -> GitResult<()> {
    let target = validate_hash(hash)?;
    repo.run(&["switch", "--detach", &target])?;
    Ok(())
}

/// 改写 HEAD 的提交信息（`commit --amend -m`，不弹交互编辑器）。
/// 注意：暂存区已有的改动会被一并并入这次修正提交。
pub fn amend_message(repo: &GitRepo, message: &str) -> GitResult<()> {
    if message.trim().is_empty() {
        return Err(GitError::CommandFailed("提交信息不能为空".into()));
    }
    repo.run(&["commit", "--amend", "-m", message])?;
    Ok(())
}

/// 变基：把当前分支的提交重放到 ref_name 之上。
/// 冲突时原样返回 CommandFailed（仓库进入变基中状态），由前端读状态分类。
pub fn rebase(repo: &GitRepo, ref_name: &str) -> GitResult<String> {
    let ref_name = ref_name.trim();
    if ref_name.is_empty() {
        return Err(GitError::CommandFailed("变基目标为空".into()));
    }
    repo.run(&["rebase", ref_name])?;
    Ok("已变基".into())
}

/// 还原普通提交（自动生成 `Revert "<subject>"` 提交，不改写历史）。
/// 合并提交需要 -m 指定主线，本版不支持并给出解释。
pub fn revert_commit(repo: &GitRepo, hash: &str) -> GitResult<String> {
    let target = validate_hash(hash)?;
    if repo.run_ok(&["rev-parse", "--verify", "--quiet", &format!("{target}^2")]) {
        return Err(GitError::CommandFailed(
            "这是合并提交：还原它需要指定保留哪条主线（-m 参数），暂不支持。".into(),
        ));
    }
    repo.run(&["-c", "core.editor=true", "revert", "--no-edit", &target])?;
    Ok("已还原该提交".into())
}

/// 摘取单提交到当前分支。失败时的语义由前端按仓库状态分类：
/// operation=cherry-pick 且无未合入文件 = 空提交；有未合入文件 = 冲突。
pub fn cherry_pick(repo: &GitRepo, hash: &str) -> GitResult<String> {
    let target = validate_hash(hash)?;
    repo.run(&["-c", "core.editor=true", "cherry-pick", &target])?;
    Ok("已摘取该提交".into())
}

/// 跳过当前卡住的 cherry-pick（空提交场景）。
pub fn cherry_pick_skip(repo: &GitRepo) -> GitResult<()> {
    repo.run(&["-c", "core.editor=true", "cherry-pick", "--skip"])?;
    Ok(())
}

/// 空提交场景下「仍然提交」（--allow-empty，沿用 CHERRY_PICK_MSG）。仅在摘取进行中可用。
pub fn cherry_pick_keep(repo: &GitRepo) -> GitResult<String> {
    if read_operation(repo) != Some(Operation::CherryPick) {
        return Err(GitError::CommandFailed("当前没有进行中的摘取操作".into()));
    }
    repo.run(&["-c", "core.editor=true", "commit", "--allow-empty", "--no-edit"])?;
    Ok("已保留空提交".into())
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
    // 上游与 ahead/behind 都在同一次 v2 输出里：不再需要 symbolic-ref / @{u} / rev-list
    let raw = repo.run(&["status", "--porcelain=v2", "--branch", "-z"])?;
    let (.., heads) = parse_status_v2(&raw);
    let (ahead, behind) = parse_branch_ab(&raw).unwrap_or((0, 0));
    Ok(BranchSummary {
        branch: branch_from_heads(repo, &heads),
        upstream: heads.upstream,
        ahead,
        behind,
    })
}

/// 抓取：多远程仓库下 `--all` 覆盖每个远程（裸 fetch 只动当前上游那一个）；
/// 指定 remote 时只抓该远程。
pub fn fetch(repo: &GitRepo, remote: Option<&str>) -> GitResult<String> {
    let remote = remote.map(str::trim).filter(|r| !r.is_empty());
    match remote {
        Some(r) => {
            repo.run(&["fetch", r])?;
            Ok(format!("已抓取 {r}"))
        }
        None => repo.run(&["fetch", "--all"]).map(|_| "抓取完成".into()),
    }
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

/// 推到指定远程（不建立上游）：把当前分支显式推到某个 remote 的同名分支，
/// 用于「一个仓库挂多个远程（gitee + github）」的场景。带 refspec 避免歧义。
pub fn push_to(repo: &GitRepo, remote: &str, branch: &str) -> GitResult<String> {
    let remote = remote.trim();
    let branch = branch.trim();
    if remote.is_empty() || branch.is_empty() {
        return Err(GitError::CommandFailed("远程或分支名为空".into()));
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    repo.run(&["push", "--quiet", remote, &refspec])
        .map_err(|e| match e {
            GitError::CommandFailed(stderr) => map_push_err(stderr),
            other => other,
        })?;
    Ok(format!("已推送 {branch} 到 {remote}/{branch}"))
}

/// 推到所有远程：逐个推送当前分支，收集成功与失败远程后一并回报
/// （部分失败仍视为整体成功，让 UI 能提示「哪几个没推上」）。
pub fn push_all_remotes(repo: &GitRepo, branch: &str) -> GitResult<String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(GitError::CommandFailed("分支名为空".into()));
    }
    let remotes = list_remotes(repo)?;
    if remotes.is_empty() {
        return Err(GitError::CommandFailed(
            "仓库没有配置远程，请先在终端 git remote add".into(),
        ));
    }
    let mut pushed = Vec::new();
    let mut failed = Vec::new();
    for remote in remotes {
        match push_to(repo, &remote, branch) {
            Ok(_) => pushed.push(remote),
            Err(GitError::CommandFailed(msg)) => failed.push((remote, msg)),
            Err(e) => return Err(e),
        }
    }
    if pushed.is_empty() {
        let detail = failed
            .iter()
            .map(|(r, m)| format!("{r}：{m}"))
            .collect::<Vec<_>>()
            .join("；");
        return Err(GitError::CommandFailed(format!(
            "全部远程推送失败：{detail}"
        )));
    }
    let mut msg = format!("已推送到 {}", pushed.join("、"));
    if !failed.is_empty() {
        msg.push_str(&format!(
            "；未推送 {}",
            failed
                .iter()
                .map(|(r, _)| r.as_str())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    Ok(msg)
}

/// 删除远程分支：显式带 `refs/heads/` 前缀，避免与同名标签歧义。
/// 先 `ls-remote` 确认分支存在 —— 本地路径远程上删除不存在的 ref 时
/// receive-pack 只给 warning 且退出码为 0，必须自己兜住「分支不存在」。
/// 真正的删除失败（无权限等）走与 push 相同的结构化映射。
pub fn delete_remote_branch(repo: &GitRepo, remote: &str, branch: &str) -> GitResult<String> {
    let remote = remote.trim();
    let branch = branch.trim();
    if remote.is_empty() || branch.is_empty() {
        return Err(GitError::CommandFailed("远程或分支名为空".into()));
    }
    let refname = format!("refs/heads/{branch}");
    let advertised = repo.run(&["ls-remote", "--heads", remote, &refname])?;
    if advertised.trim().is_empty() {
        return Err(GitError::CommandFailed(format!(
            "远程分支不存在：{remote}/{branch}"
        )));
    }
    repo.run(&["push", "--quiet", remote, "--delete", &refname])
        .map_err(|e| match e {
            GitError::CommandFailed(stderr) => map_push_err(stderr),
            other => other,
        })?;
    Ok(format!("已删除 {remote}/{branch}"))
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

    // ── 引用列表 ──

    #[test]
    fn list_refs_covers_refs_outside_first_log_page() {
        let t = repo();
        let base = t.path();
        // 300 个提交的空提交链（fast-import 一次灌完）
        let mut s = String::from("reset refs/heads/main\n");
        for i in 1..=300 {
            s.push_str(&format!(
                "commit refs/heads/main\nmark :{i}\ncommitter t <t@t.dev> {} +0000\ndata c{i}\n",
                1_700_000_000 + i as u64
            ));
        }
        // 老分支与老标签挂在第 1 个提交上 —— 落在首页 200 条之外
        s.push_str("reset refs/heads/stale\nfrom :1\n");
        s.push_str("reset refs/tags/old-tag\nfrom :1\n");
        s.push_str("reset refs/heads/fresh\nfrom :300\n");
        s.push_str("reset refs/remotes/origin/main\nfrom :300\n");
        let stream = TempDir::new().unwrap();
        let script = stream.path().join("fast.txt");
        fs::write(&script, &s).unwrap();
        let out = Command::new("git")
            .current_dir(base)
            .args(["fast-import", "--quiet"])
            .stdin(std::process::Stdio::from(fs::File::open(&script).unwrap()))
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        // 真实的 origin/HEAD 是符号 ref（fetch 之后才有），不是分支
        git(
            base,
            &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
        );

        let r = GitRepo::open(base).unwrap();
        let page = get_log(&r, 0, 200).unwrap();
        assert_eq!(page.commits.len(), 200);
        let oldest = git(base, &["rev-list", "--max-parents=0", "HEAD"]).trim().to_string();
        // 前提：老分支的 tip 确实不在首页里（否则本测试证明不了问题）
        assert!(!page.commits.iter().any(|c| c.id == oldest));

        let refs = list_refs(&r).unwrap();
        let tip_of = |name: &str| refs.iter().find(|e| e.name == name).map(|e| e.tip.clone());
        let kind_of =
            |name: &str| refs.iter().find(|e| e.name == name).map(|e| e.kind);

        // 老分支 / 老标签照样在列表里，且 tip 指向真实提交
        assert_eq!(kind_of("stale"), Some(RefKind::Branch));
        assert_eq!(kind_of("old-tag"), Some(RefKind::Tag));
        assert_eq!(tip_of("stale").as_deref(), Some(oldest.as_str()));
        assert_eq!(tip_of("old-tag").as_deref(), Some(oldest.as_str()));
        // 远程 ref 与本地分支同名也不串味
        assert_eq!(kind_of("main"), Some(RefKind::Branch));
        assert_eq!(kind_of("origin/main"), Some(RefKind::Remote));
        // 符号 ref refs/remotes/origin/HEAD 不算真实分支
        assert!(tip_of("origin/HEAD").is_none());
    }

    #[test]
    fn list_refs_peels_annotated_tag_to_commit() {
        let t = repo();
        let c1 = commit_file(t.path(), "a.txt", "1", "base");
        git(t.path(), &["tag", "-a", "-m", "release", "v1"]);
        git(t.path(), &["tag", "light"]);
        let r = GitRepo::open(t.path()).unwrap();
        let refs = list_refs(&r).unwrap();
        let tip = |n: &str| refs.iter().find(|e| e.name == n).unwrap().tip.clone();
        // 附注标签的 objectname 是 tag 对象，须剥离到所标注的提交
        assert_eq!(tip("v1"), c1);
        assert_eq!(tip("light"), c1);
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
        fetch(&r, None).unwrap();
        let s = get_branch_summary(&r).unwrap();
        assert_eq!((s.ahead, s.behind), (0, 1));
        pull(&r).unwrap();
        assert_eq!(get_branch_summary(&r).unwrap().behind, 0);
        assert!(work.path().join("remote.txt").exists());

        // 分叉：本地 +1、远程 +1 → pull 必须失败且不改动仓库
        commit_file(work.path(), "local.txt", "l1", "local diverge");
        commit_file(&c2, "remote2.txt", "r2", "remote diverge");
        git(&c2, &["push", "-q", "origin", "main"]);
        fetch(&r, None).unwrap();
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

    /// 两个 bare 远端（origin + gitee）+ 已推 origin/main 的工作仓。
    fn repo_with_two_remotes() -> (TempDir, TempDir, TempDir) {
        let gitee = TempDir::new().unwrap();
        git(gitee.path(), &["init", "-q", "--bare", "-b", "main"]);
        let (origin, work) = repo_with_origin();
        git(
            work.path(),
            &["remote", "add", "gitee", gitee.path().to_str().unwrap()],
        );
        (origin, gitee, work)
    }

    #[test]
    fn push_to_second_remote_keeps_upstream_intact() {
        let (_origin, gitee, work) = repo_with_two_remotes();
        let r = GitRepo::open(work.path()).unwrap();
        // git remote 按名称字母序输出
        assert_eq!(
            list_remotes(&r).unwrap(),
            vec!["gitee".to_string(), "origin".to_string()]
        );

        commit_file(work.path(), "b.txt", "1", "only on gitee");
        let msg = push_to(&r, "gitee", "main").unwrap();
        assert!(msg.contains("gitee/main"), "{msg}");

        // 上游仍指向 origin，gitee 上分支内容一致
        assert_eq!(
            get_branch_summary(&r).unwrap().upstream.as_deref(),
            Some("origin/main")
        );
        let head = r.run(&["rev-parse", "HEAD"]).unwrap();
        let remote_head = r
            .run(&[
                "ls-remote",
                gitee.path().to_str().unwrap(),
                "refs/heads/main",
            ])
            .unwrap();
        assert_eq!(remote_head.split_whitespace().next(), Some(head.trim()));

        // 上游未变 → 本地 ahead 计数仍按 origin 计（gitee 推送不改写它）
        assert_eq!(get_branch_summary(&r).unwrap().ahead, 1);
    }

    #[test]
    fn push_to_rejects_unknown_remote_and_empty_args() {
        let (_origin, _gitee, work) = repo_with_two_remotes();
        let r = GitRepo::open(work.path()).unwrap();
        assert!(matches!(
            push_to(&r, "github", "main"),
            Err(GitError::CommandFailed(_))
        ));
        assert!(matches!(
            push_to(&r, "gitee", " "),
            Err(GitError::CommandFailed(_))
        ));
    }

    #[test]
    fn push_all_remotes_hits_every_remote() {
        let (_origin, gitee, work) = repo_with_two_remotes();
        let r = GitRepo::open(work.path()).unwrap();
        commit_file(work.path(), "c.txt", "1", "fan out");
        let msg = push_all_remotes(&r, "main").unwrap();
        assert!(msg.contains("origin") && msg.contains("gitee"), "{msg}");

        let head = r.run(&["rev-parse", "HEAD"]).unwrap();
        for url in [
            _origin.path().to_str().unwrap(),
            gitee.path().to_str().unwrap(),
        ] {
            let out = r.run(&["ls-remote", url, "refs/heads/main"]).unwrap();
            assert_eq!(out.split_whitespace().next(), Some(head.trim()));
        }

        // 无远程仓库 → 结构化错误而不是静默成功
        let bare = repo();
        commit_file(bare.path(), "a.txt", "1", "init");
        assert!(matches!(
            push_all_remotes(&GitRepo::open(bare.path()).unwrap(), "main"),
            Err(GitError::CommandFailed(m)) if m.contains("没有配置远程")
        ));
    }

    #[test]
    fn fetch_all_pulls_every_remote() {
        let (_origin, gitee, work) = repo_with_two_remotes();
        let r = GitRepo::open(work.path()).unwrap();
        assert!(!r.run_ok(&["rev-parse", "--verify", "-q", "refs/remotes/gitee/main"]));

        // 另一个工作仓往 gitee 推 main：本地 fetch --all 后应出现 gitee/main
        let side = repo();
        git(
            side.path(),
            &["remote", "add", "gitee", gitee.path().to_str().unwrap()],
        );
        commit_file(side.path(), "g.txt", "1", "gitee side");
        git(
            side.path(),
            &["push", "-q", "gitee", "HEAD:refs/heads/main"],
        );

        fetch(&r, None).unwrap();
        assert!(r.run_ok(&["rev-parse", "--verify", "refs/remotes/gitee/main"]));
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
        fetch(&r, None).unwrap();
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
            continue_operation(&r, Operation::Merge, None),
            Err(GitError::CommandFailed(m)) if m.contains("冲突文件未解决")
        ));

        // 选边（我方）：内容恢复为 main 侧并直接进入已暂存
        resolve_take(&r, "a.txt", true).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "main\n");
        let st = get_status(&r).unwrap();
        assert!(st.unmerged.is_empty()); // 我方版本与 HEAD 一致，无差异即无暂存条目
        // 继续合并 → 产生合并提交
        continue_operation(&r, Operation::Merge, None).unwrap();
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

    #[test]
    fn revert_normal_merge_rejected_and_conflict() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1\n", "base");
        let second = commit_file(t.path(), "a.txt", "2\n", "second");
        let r = GitRepo::open(t.path()).unwrap();

        // 普通提交 revert：内容回退 + 自动提交
        revert_commit(&r, &second).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "1\n");
        let page = get_log(&r, 0, 2).unwrap();
        assert!(page.commits[0].subject.starts_with("Revert \"second\""));

        // 合并提交被拦截并解释
        commit_file(t.path(), "b.txt", "x", "for merge");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        commit_file(t.path(), "f.txt", "1", "feat work");
        git(t.path(), &["checkout", "-q", "main"]);
        git(t.path(), &["merge", "-q", "--no-ff", "-m", "Merge feat", "feat"]);
        let merge_hash = git(t.path(), &["rev-parse", "HEAD"]).trim().to_string();
        assert!(matches!(
            revert_commit(&r, &merge_hash),
            Err(GitError::CommandFailed(m)) if m.contains("合并提交")
        ));

        // revert 冲突：对同一文件连续编辑后还原较早提交 → 反向补丁上下文对不上
        let x = commit_file(t.path(), "a.txt", "2\n", "edit x");
        commit_file(t.path(), "a.txt", "3\n", "edit y");
        assert!(revert_commit(&r, &x).is_err());
        assert_eq!(get_status(&r).unwrap().operation, Some(Operation::Revert));
        abort_operation(&r, Operation::Revert).unwrap();
    }

    #[test]
    fn cherry_pick_success_empty_and_conflict() {
        let t = repo();
        commit_file(t.path(), "a.txt", "base\n", "base");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        let fix = commit_file(t.path(), "fix.txt", "fixed\n", "fix: something");
        git(t.path(), &["checkout", "-q", "main"]);
        let r = GitRepo::open(t.path()).unwrap();

        // 成功：fix.txt 落到 main，自动提交
        cherry_pick(&r, &fix).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("fix.txt")).unwrap(), "fixed\n");
        assert!(get_log(&r, 0, 1).unwrap().commits[0]
            .subject
            .contains("fix: something"));

        // 空提交：把同一提交再摘一次 → 失败但停在 cherry-pick 状态、无未合入文件
        //（语义分类在前端按状态判断，不匹配 stderr 文案）
        assert!(cherry_pick(&r, &fix).is_err());
        let st_empty = get_status(&r).unwrap();
        assert_eq!(st_empty.operation, Some(Operation::CherryPick));
        assert!(st_empty.unmerged.is_empty());
        cherry_pick_skip(&r).unwrap();
        assert!(get_status(&r).unwrap().operation.is_none());

        // 仍然提交（--allow-empty）路径
        assert!(cherry_pick(&r, &fix).is_err());
        cherry_pick_keep(&r).unwrap();
        assert!(get_status(&r).unwrap().operation.is_none());
        assert!(get_log(&r, 0, 1).unwrap().commits[0]
            .subject
            .contains("fix: something"));

        // 冲突：构造分叉后摘取对同一文件的改动
        git(t.path(), &["checkout", "-q", "feat"]);
        let clash = commit_file(t.path(), "a.txt", "feat side\n", "feat edits a");
        git(t.path(), &["checkout", "-q", "main"]);
        commit_file(t.path(), "a.txt", "main side\n", "main edits a");
        let out = Command::new("git")
            .current_dir(t.path())
            .args(["cherry-pick", &clash])
            .output()
            .unwrap();
        assert!(!out.status.success(), "夹具必须真冲突");
        assert_eq!(get_status(&r).unwrap().operation, Some(Operation::CherryPick));
        abort_operation(&r, Operation::CherryPick).unwrap();
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
    // ── 远程同步（按远程抓取 / 删除远程分支 / 上游管理） ──

    #[test]
    fn fetch_single_remote_and_all_regression() {
        let (_origin, gitee, work) = repo_with_two_remotes();
        let r = GitRepo::open(work.path()).unwrap();

        // 另一个工作仓往 gitee 推 main：本地只有 gitee 远端能提供该分支
        let side = repo();
        git(
            side.path(),
            &["remote", "add", "gitee", gitee.path().to_str().unwrap()],
        );
        commit_file(side.path(), "g.txt", "1", "gitee side");
        git(side.path(), &["push", "-q", "gitee", "HEAD:refs/heads/main"]);

        // 指定远程：只抓该远程，不碰别的远程
        assert_eq!(fetch(&r, Some("origin")).unwrap(), "已抓取 origin");
        assert!(!r.run_ok(&["rev-parse", "--verify", "--quiet", "refs/remotes/gitee/main"]));
        assert!(r.run_ok(&["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]));

        // 无参 / 全空白：仍是 --all 行为（回归）
        assert_eq!(fetch(&r, None).unwrap(), "抓取完成");
        assert!(r.run_ok(&["rev-parse", "--verify", "--quiet", "refs/remotes/gitee/main"]));
        assert_eq!(fetch(&r, Some("  ")).unwrap(), "抓取完成");
    }

    #[test]
    fn delete_remote_branch_success_and_missing() {
        let (origin, work) = repo_with_origin();
        let r = GitRepo::open(work.path()).unwrap();
        // 先在远端造一个分支
        git(work.path(), &["push", "-q", "origin", "main:refs/heads/topic"]);
        let remote_ref = |name: &str| {
            git(
                origin.path(),
                &["for-each-ref", "--format=%(refname)", name],
            )
            .trim()
            .to_string()
        };
        assert_eq!(remote_ref("refs/heads/topic"), "refs/heads/topic");

        assert_eq!(
            delete_remote_branch(&r, "origin", "topic").unwrap(),
            "已删除 origin/topic"
        );
        assert!(remote_ref("refs/heads/topic").is_empty());

        // 分支不存在 / 空参 → 结构化错误
        assert!(matches!(
            delete_remote_branch(&r, "origin", "no-such"),
            Err(GitError::CommandFailed(_))
        ));
        assert!(matches!(
            delete_remote_branch(&r, "  ", "topic"),
            Err(GitError::CommandFailed(m)) if m.contains("远程或分支名为空")
        ));
        assert!(matches!(
            delete_remote_branch(&r, "origin", ""),
            Err(GitError::CommandFailed(m)) if m.contains("远程或分支名为空")
        ));
    }

    #[test]
    fn upstream_set_unset_and_list_refs_field() {
        let (_origin, work) = repo_with_origin();
        let r = GitRepo::open(work.path()).unwrap();
        git(work.path(), &["branch", "feature"]);
        git(work.path(), &["tag", "v1"]);

        let up_of = |name: &str| {
            r.run(&[
                "for-each-ref",
                "--format=%(upstream:short)",
                &format!("refs/heads/{name}"),
            ])
            .unwrap()
            .trim()
            .to_string()
        };
        assert_eq!(up_of("feature"), "");

        // 建立上游：for-each-ref 与 list_refs 的 upstream 字段一致
        set_upstream(&r, "feature", "origin/main").unwrap();
        assert_eq!(up_of("feature"), "origin/main");
        let refs = list_refs(&r).unwrap();
        let entry = |name: &str| refs.iter().find(|e| e.name == name).cloned().unwrap();
        assert_eq!(entry("main").kind, RefKind::Branch);
        assert_eq!(entry("main").upstream.as_deref(), Some("origin/main"));
        assert_eq!(entry("feature").upstream.as_deref(), Some("origin/main"));
        // 远程 ref 与标签天然没有上游
        assert_eq!(entry("origin/main").kind, RefKind::Remote);
        assert_eq!(entry("origin/main").upstream, None);
        assert_eq!(entry("v1").kind, RefKind::Tag);
        assert_eq!(entry("v1").upstream, None);

        // 解除上游（upstream 是快照字段，须重新读取引用列表）
        unset_upstream(&r, "feature").unwrap();
        assert_eq!(up_of("feature"), "");

        // 取消当前分支上游后，branch_summary 的 ahead/behind 必须归零（侧栏徽章依据）
        commit_file(work.path(), "ahead.txt", "x", "ahead");
        let s = get_branch_summary(&r).unwrap();
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (1, 0));
        unset_upstream(&r, "main").unwrap();
        let s = get_branch_summary(&r).unwrap();
        assert_eq!(s.upstream, None);
        assert_eq!((s.ahead, s.behind), (0, 0));
        let refs2 = list_refs(&r).unwrap();
        assert_eq!(
            refs2.iter().find(|e| e.name == "feature").unwrap().upstream,
            None
        );

        // 空参
        assert!(matches!(
            set_upstream(&r, "", "origin/main"),
            Err(GitError::CommandFailed(m)) if m.contains("分支或上游为空")
        ));
        assert!(matches!(
            set_upstream(&r, "feature", "   "),
            Err(GitError::CommandFailed(m)) if m.contains("分支或上游为空")
        ));
        assert!(matches!(
            unset_upstream(&r, " "),
            Err(GitError::CommandFailed(m)) if m.contains("分支名为空")
        ));
    }

    // ── 标签 / 检出 / 修正提交信息 / 变基 / 与 HEAD 比较 ──

    #[test]
    fn create_tag_lightweight_and_annotated() {
        let t = repo();
        let c1 = commit_file(t.path(), "a.txt", "1", "base");
        let c2 = commit_file(t.path(), "a.txt", "2", "second");
        let r = GitRepo::open(t.path()).unwrap();
        let fields = |name: &str| -> Vec<String> {
            r.run(&[
                "for-each-ref",
                "--format=%(objecttype) %(objectname) %(*objectname)",
                &format!("refs/tags/{name}"),
            ])
            .unwrap()
            .split_whitespace()
            .map(str::to_string)
            .collect()
        };

        // 轻量标签：ref 直接指向 commit 对象（无剥离对象）
        create_tag(&r, "lw", &c1, None).unwrap();
        let lw = fields("lw");
        assert_eq!(lw.len(), 2);
        assert_eq!(lw[0], "commit");
        assert_eq!(lw[1], c1);

        // 附注标签：tag 对象剥离到目标提交；message 全空白视作轻量
        create_tag(&r, "ann", &c2, Some("发布说明")).unwrap();
        let ann = fields("ann");
        assert_eq!(ann[0], "tag");
        assert_eq!(ann[2], c2);
        create_tag(&r, "blank-msg", &c1, Some("   ")).unwrap();
        assert_eq!(fields("blank-msg")[0], "commit");

        // 重名 / 空名 / 非法目标 → Err
        assert!(matches!(
            create_tag(&r, "lw", &c2, None),
            Err(GitError::CommandFailed(_))
        ));
        assert!(matches!(
            create_tag(&r, "  ", &c1, None),
            Err(GitError::CommandFailed(m)) if m.contains("标签名不能为空")
        ));
        assert!(matches!(
            create_tag(&r, "bad", "not-a-hash", None),
            Err(GitError::CommandFailed(_))
        ));
    }

    #[test]
    fn checkout_remote_branch_sets_upstream() {
        let (_origin, work) = repo_with_origin();
        let r = GitRepo::open(work.path()).unwrap();
        // 远端有 topic（本地还没有）：抓取后按远程分支检出（侧栏「远程分支 → 检出」的路径）
        git(work.path(), &["push", "-q", "origin", "main:refs/heads/topic"]);
        git(work.path(), &["fetch", "-q", "origin"]);
        create_branch(&r, "topic", true, Some("origin/topic")).unwrap();

        assert_eq!(r.current_branch(), "topic");
        let up = git(
            work.path(),
            &[
                "for-each-ref",
                "--format=%(upstream:short)",
                "refs/heads/topic",
            ],
        )
        .trim()
        .to_string();
        assert_eq!(up, "origin/topic");
        // list_refs 与 for-each-ref 一致：侧栏据此决定「设置上游 / 取消上游」的可用性
        let entry = list_refs(&r)
            .unwrap()
            .into_iter()
            .find(|e| e.name == "topic")
            .unwrap();
        assert_eq!(entry.upstream.as_deref(), Some("origin/topic"));
    }

    #[test]
    fn checkout_commit_detaches_head_without_upstream() {
        let t = repo();
        let c1 = commit_file(t.path(), "a.txt", "1", "base");
        commit_file(t.path(), "a.txt", "2", "second");
        let r = GitRepo::open(t.path()).unwrap();

        checkout_commit(&r, &c1).unwrap();
        assert!(!r.run_ok(&["symbolic-ref", "--short", "HEAD"]));
        assert_eq!(r.run(&["rev-parse", "HEAD"]).unwrap().trim(), c1);
        assert_eq!(fs::read_to_string(t.path().join("a.txt")).unwrap(), "1");
        assert_eq!(get_branch_summary(&r).unwrap().upstream, None);
        // 前端 menus.ts detachedHead() 按该字符串识别分离态：格式固定为 `(HEAD detached at <十六进制短号>)`
        let branch = get_branch_summary(&r).unwrap().branch;
        let short = branch
            .strip_prefix("(HEAD detached at ")
            .and_then(|s| s.strip_suffix(')'))
            .expect("分离态分支串格式变了：前端 detachedHead() 会失效");
        assert!(!short.is_empty() && short.chars().all(|c| c.is_ascii_hexdigit()));

        assert!(matches!(
            checkout_commit(&r, "zz"),
            Err(GitError::CommandFailed(_))
        ));
        assert!(matches!(
            checkout_commit(&r, "   "),
            Err(GitError::CommandFailed(_))
        ));
    }

    #[test]
    fn amend_message_rewrites_head_and_folds_staged() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1", "base");
        let c2 = commit_file(t.path(), "a.txt", "2", "second");
        let r = GitRepo::open(t.path()).unwrap();

        // 空信息拒绝
        assert!(matches!(
            amend_message(&r, "   "),
            Err(GitError::CommandFailed(m)) if m.contains("提交信息不能为空")
        ));

        // 改写信息：哈希变化，提交数不变
        amend_message(&r, "改写后的信息").unwrap();
        let page = get_log(&r, 0, 2).unwrap();
        assert_eq!(page.commits[0].subject, "改写后的信息");
        assert_ne!(page.commits[0].id, c2);
        assert_eq!(git(t.path(), &["rev-list", "--count", "HEAD"]).trim(), "2");

        // 多行信息保留换行与缩进（-m 已给，不弹编辑器）
        amend_message(&r, "标题行\n\n- 要点一\n  缩进续行").unwrap();
        let body = r.run(&["show", "-s", "--format=%B", "HEAD"]).unwrap();
        assert!(body.contains("标题行"), "{body}");
        assert!(body.contains("- 要点一"), "{body}");
        assert!(body.contains("  缩进续行"), "{body}");

        // 暂存区非空：暂存改动会被并入修正提交（前端据此提示风险）
        fs::write(t.path().join("staged.txt"), "staged content\n").unwrap();
        git(t.path(), &["add", "--", "staged.txt"]);
        amend_message(&r, "并入暂存改动").unwrap();
        assert_eq!(git(t.path(), &["rev-list", "--count", "HEAD"]).trim(), "2");
        let stat = git(t.path(), &["show", "--stat", "--format=", "HEAD"]);
        assert!(stat.contains("staged.txt"), "{stat}");
        assert_eq!(git(t.path(), &["show", "HEAD:staged.txt"]), "staged content\n");
    }

    #[test]
    fn rebase_clean_replays_commits_onto_target() {
        let t = repo();
        commit_file(t.path(), "a.txt", "base\n", "base");
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        commit_file(t.path(), "feat.txt", "f1\n", "feat 1");
        commit_file(t.path(), "feat2.txt", "f2\n", "feat 2");
        git(t.path(), &["checkout", "-q", "main"]);
        commit_file(t.path(), "main.txt", "m1\n", "main 1");
        let r = GitRepo::open(t.path()).unwrap();

        assert!(matches!(
            rebase(&r, "  "),
            Err(GitError::CommandFailed(m)) if m.contains("变基目标为空")
        ));

        git(t.path(), &["checkout", "-q", "feat"]);
        assert_eq!(rebase(&r, "main").unwrap(), "已变基");
        let page = get_log(&r, 0, 4).unwrap();
        let subjects: Vec<&str> = page.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(&subjects[..3], &["feat 2", "feat 1", "main 1"]);
        assert!(r.run_ok(&["merge-base", "--is-ancestor", "main", "feat"]));
        assert!(get_status(&r).unwrap().operation.is_none());
    }

    #[test]
    fn rebase_conflict_continue_abort_and_skip() {
        // 冲突夹具：base → feat 改 a.txt；main 也改 a.txt
        let setup = || {
            let t = repo();
            commit_file(t.path(), "a.txt", "base\n", "base");
            git(t.path(), &["checkout", "-q", "-b", "feat"]);
            commit_file(t.path(), "a.txt", "feat\n", "feat edit");
            git(t.path(), &["checkout", "-q", "main"]);
            commit_file(t.path(), "a.txt", "main\n", "main edit");
            t
        };

        // 1) 冲突停下：operation = rebase 且未合入清单非空
        let t = setup();
        let r = GitRepo::open(t.path()).unwrap();
        git(t.path(), &["checkout", "-q", "feat"]);
        assert!(matches!(rebase(&r, "main"), Err(GitError::CommandFailed(_))));
        let st = get_status(&r).unwrap();
        assert_eq!(st.operation, Some(Operation::Rebase));
        assert!(st.unmerged.iter().any(|f| f.path == "a.txt"));

        // 2) 冲突未清空时 continue 被拒
        assert!(matches!(
            continue_operation(&r, Operation::Rebase, None),
            Err(GitError::CommandFailed(m)) if m.contains("冲突文件未解决")
        ));

        // 3) 解决后 continue 完成，提交被重放到 main 之上
        fs::write(t.path().join("a.txt"), "resolved\n").unwrap();
        git(t.path(), &["add", "--", "a.txt"]);
        assert_eq!(
            continue_operation(&r, Operation::Rebase, None).unwrap(),
            "已完成"
        );
        assert!(get_status(&r).unwrap().operation.is_none());
        assert_eq!(
            git(t.path(), &["log", "--format=%s", "-1", "feat"]).trim(),
            "feat edit"
        );
        assert!(r.run_ok(&["merge-base", "--is-ancestor", "main", "feat"]));

        // 4) abort 完整回到变基前（提交与分支指针都不动）
        let t2 = setup();
        let r2 = GitRepo::open(t2.path()).unwrap();
        git(t2.path(), &["checkout", "-q", "feat"]);
        let feat_before = git(t2.path(), &["rev-parse", "feat"]).trim().to_string();
        let log_before = git(t2.path(), &["log", "--format=%s", "--all", "--topo-order"]);
        assert!(rebase(&r2, "main").is_err());
        assert_eq!(get_status(&r2).unwrap().operation, Some(Operation::Rebase));
        abort_operation(&r2, Operation::Rebase).unwrap();
        assert!(get_status(&r2).unwrap().operation.is_none());
        assert_eq!(git(t2.path(), &["rev-parse", "feat"]).trim(), feat_before);
        assert_eq!(git(t2.path(), &["rev-parse", "HEAD"]).trim(), feat_before);
        assert_eq!(
            git(t2.path(), &["log", "--format=%s", "--all", "--topo-order"]),
            log_before
        );

        // 5) skip 丢弃本次提交继续（feat 只有一个提交 → 直接落到 main）
        let t3 = setup();
        let r3 = GitRepo::open(t3.path()).unwrap();
        git(t3.path(), &["checkout", "-q", "feat"]);
        assert!(rebase(&r3, "main").is_err());
        assert_eq!(
            continue_operation(&r3, Operation::Rebase, Some("skip")).unwrap(),
            "已跳过本次提交"
        );
        assert!(get_status(&r3).unwrap().operation.is_none());
        assert_eq!(
            git(t3.path(), &["rev-parse", "feat"]).trim(),
            git(t3.path(), &["rev-parse", "main"]).trim()
        );
        assert_eq!(fs::read_to_string(t3.path().join("a.txt")).unwrap(), "main\n");

        // 6) 动作合法性：skip 只支持变基；未知动作非法；无进行中操作被拒
        let t4 = setup();
        commit_file(t4.path(), "a.txt", "merge-side\n", "merge side");
        let out = Command::new("git")
            .current_dir(t4.path())
            .args(["merge", "--no-ff", "feat"])
            .output()
            .unwrap();
        assert!(!out.status.success(), "夹具必须真冲突");
        let r4 = GitRepo::open(t4.path()).unwrap();
        assert_eq!(get_status(&r4).unwrap().operation, Some(Operation::Merge));
        assert!(matches!(
            continue_operation(&r4, Operation::Merge, Some("skip")),
            Err(GitError::CommandFailed(m)) if m.contains("该操作不支持跳过")
        ));
        assert!(matches!(
            continue_operation(&r4, Operation::Merge, Some("bogus")),
            Err(GitError::CommandFailed(m)) if m.contains("非法动作")
        ));
        assert!(matches!(
            continue_operation(&r3, Operation::Rebase, None),
            Err(GitError::CommandFailed(m)) if m.contains("没有进行中的对应操作")
        ));
    }

    #[test]
    fn get_compare_files_patch_and_edge_cases() {
        let t = repo();
        let c1 = commit_file(t.path(), "a.txt", "1\n", "base");
        let c2 = commit_file(t.path(), "a.txt", "2\n", "second");
        commit_file(t.path(), "b.txt", "new\n", "third");
        let c3 = git(t.path(), &["rev-parse", "HEAD"]).trim().to_string();
        let r = GitRepo::open(t.path()).unwrap();

        let cmp = get_compare(&r, &c1, &c3).unwrap();
        assert_eq!(cmp.base.id, c1);
        assert_eq!(cmp.head.id, c3);
        assert_eq!(cmp.base.subject, "base");
        assert_eq!(cmp.head.subject, "third");
        let a = cmp.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.add, a.del), (1, 1));
        assert!(cmp.files.iter().any(|f| f.path == "b.txt"));
        let patch = cmp.patch.as_deref().unwrap();
        assert!(patch.contains("diff --git a/a.txt b/a.txt"), "{patch}");
        assert!(patch.contains("+2"), "{patch}");

        // 相同提交：无差异
        let same = get_compare(&r, &c1, &c1).unwrap();
        assert!(same.files.is_empty());
        assert!(same.patch.is_none());

        // 反向比较也合法（patch 为反向 diff）
        let rev = get_compare(&r, &c3, &c1).unwrap();
        assert!(rev.patch.as_deref().unwrap().contains("-2"));

        // 非法 / 不存在哈希
        assert!(matches!(
            get_compare(&r, "zz", &c2),
            Err(GitError::CommandFailed(_))
        ));
        assert!(matches!(
            get_compare(&r, &c1, "   "),
            Err(GitError::CommandFailed(_))
        ));
        assert!(matches!(
            get_compare(&r, &c1, "deadbeef"),
            Err(GitError::CommandFailed(_))
        ));
    }

    #[test]
    fn get_compare_accepts_literal_head() {
        let t = repo();
        let c1 = commit_file(t.path(), "a.txt", "1\n", "base");
        commit_file(t.path(), "a.txt", "2\n", "second");
        let head_id = git(t.path(), &["rev-parse", "HEAD"]).trim().to_string();
        let r = GitRepo::open(t.path()).unwrap();

        // 右栏「与 HEAD 比较」传的就是字面量 HEAD：基准解析为调用瞬间的 HEAD
        let cmp = get_compare(&r, "HEAD", &c1).unwrap();
        assert_eq!(cmp.base.id, head_id);
        assert_eq!(cmp.head.id, c1);
        assert_eq!(cmp.base.subject, "second");
        // 大小写不敏感，且 git 的 @ 同义写法一并接受
        assert_eq!(get_compare(&r, "head", &c1).unwrap().base.id, head_id);
        assert_eq!(get_compare(&r, "@", &c1).unwrap().base.id, head_id);
        // HEAD 与自身比较：无差异
        let self_cmp = get_compare(&r, "HEAD", "HEAD").unwrap();
        assert!(self_cmp.files.is_empty());
        assert!(self_cmp.patch.is_none());
    }

    // ── 图谱筛选（分支 / 提交者 / 日期） ──

    /// 指定作者与提交时间造一个提交：筛选测试必须能控制「谁」和「什么时候」。
    fn commit_as(
        dir: &Path,
        path: &str,
        content: &str,
        msg: &str,
        name: &str,
        email: &str,
        secs_ago: u64,
    ) {
        fs::write(dir.join(path), content).unwrap();
        git(dir, &["add", "--", path]);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - secs_ago;
        let when = format!("{ts} +0000");
        let out = Command::new("git")
            .current_dir(dir)
            .args(["commit", "-q", "-m", msg])
            .env("GIT_AUTHOR_NAME", name)
            .env("GIT_AUTHOR_EMAIL", email)
            .env("GIT_AUTHOR_DATE", &when)
            .env("GIT_COMMITTER_DATE", &when)
            .output()
            .expect("git commit 执行失败");
        assert!(
            out.status.success(),
            "git commit 失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 夹具：main 两个提交（10 天前的 a.b、1 小时前的 axb），再分出 feat / other 各一个提交。
    fn filter_fixture() -> TempDir {
        let t = repo();
        commit_as(t.path(), "a.txt", "1\n", "old commit", "a.b", "ab@x.dev", 10 * 24 * 3600);
        commit_as(t.path(), "b.txt", "2\n", "recent axb", "axb", "axb@x.dev", 3600);
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        commit_as(t.path(), "c.txt", "3\n", "feat work", "Cara", "c@x.dev", 1800);
        git(t.path(), &["checkout", "-q", "main"]);
        git(t.path(), &["checkout", "-q", "-b", "other"]);
        commit_as(t.path(), "d.txt", "4\n", "other work", "Dan", "d@x.dev", 600);
        t
    }

    #[test]
    fn log_filter_branch_author_and_since() {
        let t = filter_fixture();
        let r = GitRepo::open(t.path()).unwrap();
        let subjects = |f: &LogFilter| {
            get_log_filtered(&r, 0, 50, f)
                .unwrap()
                .commits
                .iter()
                .map(|c| c.subject.clone())
                .collect::<Vec<_>>()
        };
        let only = |b: &str| LogFilter {
            branch: Some(b.to_string()),
            ..Default::default()
        };

        // 无筛选 = 既有行为：--all 全分支（4 个提交）
        assert_eq!(subjects(&LogFilter::default()).len(), 4);
        // 分支筛选：main 不含两个分叉分支上的提交
        let main = subjects(&only("main"));
        assert_eq!(main.len(), 2);
        assert!(!main.iter().any(|s| s == "feat work" || s == "other work"));
        assert_eq!(subjects(&only("feat")).len(), 3);
        assert_eq!(subjects(&only("other")).len(), 3);
        // 空白分支名视为未筛选（前端清筛选时可能传空串）
        assert_eq!(subjects(&only("   ")).len(), 4);

        // 提交者：固定串匹配——`a.b` 若按正则解释会连 `axb` 一起命中
        let author = |a: &str| LogFilter {
            author: Some(a.to_string()),
            ..Default::default()
        };
        assert_eq!(subjects(&author("a.b")), vec!["old commit"]);
        assert_eq!(subjects(&author("axb@x.dev")), vec!["recent axb"]);
        assert_eq!(subjects(&author("Cara")), vec!["feat work"]);

        // 时间：10 天前的提交落在 day / week 之外，落在 month 之内
        let since = |s: &str| LogFilter {
            since: Some(s.to_string()),
            ..Default::default()
        };
        assert_eq!(subjects(&since("day")).len(), 3);
        assert_eq!(subjects(&since("week")).len(), 3);
        assert_eq!(subjects(&since("month")).len(), 4);
        assert!(!subjects(&since("day")).iter().any(|s| s == "old commit"));

        // 组合：分支 + 提交者 + 时间同时生效
        let combo = LogFilter {
            branch: Some("feat".to_string()),
            author: Some("Cara".to_string()),
            since: Some("week".to_string()),
        };
        assert_eq!(subjects(&combo), vec!["feat work"]);

        // 分页在过滤后的集合上算：main 只有 2 个提交
        let f = only("main");
        let first = get_log_filtered(&r, 0, 1, &f).unwrap();
        assert_eq!(first.commits.len(), 1);
        assert!(!first.done);
        let past_end = get_log_filtered(&r, 2, 1, &f).unwrap();
        assert!(past_end.commits.is_empty());
        assert!(past_end.done);
    }

    #[test]
    fn log_filter_rejects_bad_args() {
        let t = filter_fixture();
        let r = GitRepo::open(t.path()).unwrap();

        // 不存在的分支：给可读错误，而不是把 git 的 stderr 直接抛给用户
        let missing = LogFilter {
            branch: Some("nope".to_string()),
            ..Default::default()
        };
        match get_log_filtered(&r, 0, 10, &missing) {
            Err(GitError::CommandFailed(m)) => assert!(m.contains("分支不存在"), "{m}"),
            other => panic!("应拒绝不存在的分支，实际：{other:?}"),
        }
        // 以 `-` 开头：防把它当成 git 选项（参数注入）。文案要和「分支不存在」可区分，
        // 否则这条断言在删掉 starts_with('-') 检查后依然会通过（两条路径都会 rev-parse 失败）
        let injected = LogFilter {
            branch: Some("--all".to_string()),
            ..Default::default()
        };
        match get_log_filtered(&r, 0, 10, &injected) {
            Err(GitError::CommandFailed(m)) => assert!(m.contains("非法分支名"), "{m}"),
            other => panic!("应拒绝以 - 开头的分支名，实际：{other:?}"),
        }
        // 时间范围白名单之外的档位一律拒绝
        let bad_since = LogFilter {
            since: Some("year".to_string()),
            ..Default::default()
        };
        match get_log_filtered(&r, 0, 10, &bad_since) {
            Err(GitError::CommandFailed(m)) => assert!(m.contains("非法时间范围"), "{m}"),
            other => panic!("应拒绝非法时间范围，实际：{other:?}"),
        }
    }

    #[test]
    fn user_identity_from_config() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1\n", "init");
        let r = GitRepo::open(t.path()).unwrap();

        let id = get_user_identity(&r);
        assert_eq!(id.name.as_deref(), Some("Fumi Test"));
        assert_eq!(id.email.as_deref(), Some("test@fumigit.dev"));

        // 配置被清空（或只有空白）→ None，而不是回落到全局配置
        git(t.path(), &["config", "user.email", ""]);
        git(t.path(), &["config", "user.name", "   "]);
        let blank = get_user_identity(&r);
        assert_eq!(blank.email, None);
        assert_eq!(blank.name, None);
    }
    /// 无筛选日志（既有用例的默认视角）：等价 `get_log_filtered(.., &LogFilter::default())`。
    /// 生产路径只有带筛选的版本（commands.rs 传 `LogFilter`），这里留一个三参数别名，
    /// 免得二十来条既有断言被筛选参数淹掉。
    fn get_log(repo: &GitRepo, skip: usize, limit: usize) -> GitResult<LogPage> {
        get_log_filtered(repo, skip, limit, &LogFilter::default())
    }

    // ── 调用折叠：status v2 / show 输出合一（工单 02） ────────────────────────
    //
    // 改造前 v1 解析逻辑的两份副本（working tree status 与 name-status）都搬到这里：
    // 它们只是「新实现与旧实现逐位等价」的比对面，不属于生产路径。

    /// v1 冲突判定（改造前为模块级 `is_unmerged`，随 v1 解析一起退休）。
    fn is_unmerged(x: char, y: char) -> bool {
        // porcelain 冲突对：UU AA DD AU UA DU UD
        matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'))
    }

    /// 改造前 `get_status` 的内联解析：逐字搬进测试作基线。
    fn parse_status_v1_for_test(raw: &str) -> (Vec<FileEntry>, Vec<FileEntry>, Vec<FileEntry>) {
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
        (staged, unstaged, unmerged)
    }

    /// 改造前被删掉的 name-status 解析：提交详情 files 的等价对照基线（逐字搬进测试）。
    fn name_status_v1_for_test(raw: &str) -> std::collections::HashMap<String, char> {
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

    /// 工作区三组列表的逐位快照（路径 / 原路径 / 状态）。
    fn snapshot(files: &[FileEntry]) -> Vec<(String, Option<String>, char)> {
        files
            .iter()
            .map(|e| (e.path.clone(), e.old_path.clone(), e.status))
            .collect()
    }

    /// 文件统计的逐位快照（用于与改造前的 `Vec<FileStat>` 逐字段对照）。
    fn stat_snapshot(files: &[FileStat]) -> Vec<(String, Option<String>, char, u32, u32, bool)> {
        files
            .iter()
            .map(|f| {
                (
                    f.path.clone(),
                    f.old_path.clone(),
                    f.status,
                    f.add,
                    f.del,
                    f.binary,
                )
            })
            .collect()
    }

    /// 七种形态同盘的夹具：普通修改 / 已暂存新增 / 已暂存删除 / 重命名 /
    /// 未跟踪 / 冲突（unmerged）/ 忽略文件（未传 --ignored，两种格式都应看不到）。
    fn status_shapes_fixture() -> TempDir {
        let t = repo();
        commit_file(t.path(), "a.txt", "base\n", "base"); // 冲突候选
        commit_file(t.path(), "mod.txt", "1\n", "mod base");
        commit_file(t.path(), "rm.txt", "gone\n", "rm base");
        commit_file(t.path(), "keep.txt", "k\n", "keep base");
        commit_file(t.path(), ".gitignore", "ignored.txt\n", "ignore rules");
        // 冲突：两侧各改一处再 merge（真冲突，git merge 必然失败）
        git(t.path(), &["checkout", "-q", "-b", "feat"]);
        fs::write(t.path().join("a.txt"), "feat\n").unwrap();
        git(t.path(), &["commit", "-q", "-am", "feat side"]);
        git(t.path(), &["checkout", "-q", "main"]);
        fs::write(t.path().join("a.txt"), "main\n").unwrap();
        git(t.path(), &["commit", "-q", "-am", "main side"]);
        let merge = Command::new("git")
            .current_dir(t.path())
            .args(["merge", "feat"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "夹具必须真冲突");
        // 已暂存新增 / 已暂存删除 / 重命名（都不碰冲突路径）
        fs::write(t.path().join("added.txt"), "new\n").unwrap();
        git(t.path(), &["add", "--", "added.txt"]);
        git(t.path(), &["rm", "-q", "--", "rm.txt"]);
        git(t.path(), &["mv", "keep.txt", "renamed.txt"]);
        // 普通修改 / 未跟踪 / 忽略
        fs::write(t.path().join("mod.txt"), "2\n").unwrap();
        fs::write(t.path().join("untracked.txt"), "u\n").unwrap();
        fs::write(t.path().join("ignored.txt"), "i\n").unwrap();
        t
    }

    /// 本票最强的回归证据：同一夹具上 v1 与 v2 两套解析逐位相等。
    #[test]
    fn status_v1_and_v2_parsers_agree_bit_for_bit() {
        let t = status_shapes_fixture();
        let r = GitRepo::open(t.path()).unwrap();
        let raw_v1 = git(t.path(), &["status", "--porcelain", "-z"]);
        let raw_v2 = git(t.path(), &["status", "--porcelain=v2", "--branch", "-z"]);
        let (s1, u1, m1) = parse_status_v1_for_test(&raw_v1);
        let (s2, u2, m2, _heads) = parse_status_v2(&raw_v2);

        // 七种形态真的都在夹具里，对照才不是空转
        let has =
            |v: &[FileEntry], p: &str, st: char| v.iter().any(|e| e.path == p && e.status == st);
        assert!(has(&s1, "added.txt", 'A'), "{s1:?}");
        assert!(has(&s1, "rm.txt", 'D'), "{s1:?}");
        assert!(has(&s1, "renamed.txt", 'R'), "{s1:?}");
        assert!(has(&u1, "mod.txt", 'M'), "{u1:?}");
        assert!(has(&u1, "untracked.txt", 'A'), "{u1:?}");
        assert!(has(&m1, "a.txt", 'U'), "{m1:?}");
        assert!(s1.iter().all(|e| e.path != "ignored.txt"), "{s1:?}");
        assert!(u1.iter().all(|e| e.path != "ignored.txt"), "{u1:?}");
        assert_eq!(
            s1.iter()
                .find(|e| e.path == "renamed.txt")
                .unwrap()
                .old_path
                .as_deref(),
            Some("keep.txt")
        );

        // v1 / v2 两套解析逐位相等（含组内顺序）
        assert_eq!(snapshot(&s1), snapshot(&s2), "staged 组不一致");
        assert_eq!(snapshot(&u1), snapshot(&u2), "unstaged 组不一致");
        assert_eq!(snapshot(&m1), snapshot(&m2), "unmerged 组不一致");

        // 生产路径（v2）在同一夹具上与 v1 基线逐位相同
        let st = get_status(&r).unwrap();
        assert_eq!(snapshot(&st.staged), snapshot(&s1));
        assert_eq!(snapshot(&st.unstaged), snapshot(&u1));
        assert_eq!(snapshot(&st.unmerged), snapshot(&m1));
    }

    /// `branch` 字符串三态：常规分支 / 分离 HEAD / 空仓库。
    #[test]
    fn status_and_summary_branch_strings() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1\n", "base");
        let r = GitRepo::open(t.path()).unwrap();
        assert_eq!(get_status(&r).unwrap().branch, "main");
        assert_eq!(get_branch_summary(&r).unwrap().branch, "main");

        // 分离 HEAD：短 id 长度由 git（core.abbrev）决定，不能自己截 40 位 oid
        git(t.path(), &["checkout", "-q", "--detach", "HEAD"]);
        let short = git(t.path(), &["rev-parse", "--short", "HEAD"])
            .trim()
            .to_string();
        let want = format!("(HEAD detached at {short})");
        assert_eq!(get_status(&r).unwrap().branch, want);
        assert_eq!(get_branch_summary(&r).unwrap().branch, want);

        // 空仓库（无提交）：symbolic-ref 仍给出分支名
        let empty = repo();
        let er = GitRepo::open(empty.path()).unwrap();
        assert_eq!(get_status(&er).unwrap().branch, "main");
        assert_eq!(get_branch_summary(&er).unwrap().branch, "main");
    }

    /// 上游与 ahead/behind：与 `# branch.ab` 及 `rev-list --left-right --count` 两侧对账。
    #[test]
    fn branch_summary_upstream_and_ab_pair() {
        let (origin, work) = repo_with_origin();
        // 本地 +2、远端 +1 → 分叉
        commit_file(work.path(), "l1.txt", "1\n", "local 1");
        commit_file(work.path(), "l2.txt", "2\n", "local 2");
        let side = TempDir::new().unwrap();
        let clone = side.path().join("c");
        git(
            side.path(),
            &[
                "clone",
                "-q",
                origin.path().to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
        commit_file(&clone, "r.txt", "r\n", "remote 1");
        git(&clone, &["push", "-q", "origin", "main"]);

        let r = GitRepo::open(work.path()).unwrap();
        fetch(&r, None).unwrap();
        let s = get_branch_summary(&r).unwrap();
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));

        let raw = git(work.path(), &["status", "--porcelain=v2", "--branch", "-z"]);
        assert_eq!(parse_branch_ab(&raw), Some((2, 1)));
        let rev = git(
            work.path(),
            &["rev-list", "--left-right", "--count", "HEAD...origin/main"],
        );
        let mut it = rev.split_whitespace();
        let pair = (
            it.next().unwrap().parse::<u32>().unwrap(),
            it.next().unwrap().parse::<u32>().unwrap(),
        );
        assert_eq!(pair, (s.ahead, s.behind));

        // 无有效上游：`# branch.upstream` / `# branch.ab` 都不出现 → None 与 0/0
        let plain = repo();
        commit_file(plain.path(), "a.txt", "1\n", "base");
        let pr = GitRepo::open(plain.path()).unwrap();
        let ps = get_branch_summary(&pr).unwrap();
        assert_eq!(ps.upstream, None);
        assert_eq!((ps.ahead, ps.behind), (0, 0));
        let np = git(plain.path(), &["status", "--porcelain=v2", "--branch", "-z"]);
        assert_eq!(parse_branch_ab(&np), None);
    }

    /// 旧实现用的 `rev-parse --git-path <name>`：作为「gitdir 拼接等价」的对照面。
    fn git_path_probe(root: &Path, name: &str) -> PathBuf {
        let raw = git(root, &["rev-parse", "--git-path", name]);
        let p = PathBuf::from(raw.trim());
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    }

    /// 五个中间态名字上，`<gitdir>/<name>` 必须与 `--git-path` 解析到同一个路径。
    fn assert_gitdir_equivalent(root: &Path, repo: &GitRepo) {
        for name in [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-merge",
            "rebase-apply",
        ] {
            assert_eq!(
                git_path_probe(root, name),
                repo.gitdir.join(name),
                "{name}：gitdir 拼接必须等于 rev-parse --git-path"
            );
        }
    }

    #[test]
    fn gitdir_for_root_subdir_and_linked_worktree() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1\n", "base");
        fs::create_dir_all(t.path().join("sub")).unwrap();

        // 1) 仓库根
        let r = GitRepo::open(t.path()).unwrap();
        assert_eq!(r.root, t.path());
        assert_eq!(r.gitdir, t.path().join(".git"));
        assert_gitdir_equivalent(t.path(), &r);

        // 2) 子目录打开：root 归一化到仓库根，gitdir 仍是同一个
        let sub = t.path().join("sub");
        let rs = GitRepo::open(&sub).unwrap();
        assert_eq!(rs.root, t.path());
        assert_eq!(rs.gitdir, r.gitdir);
        assert_gitdir_equivalent(t.path(), &rs);

        // 3) linked worktree：`.git` 是文件，gitdir 是 per-worktree 目录
        let wt_home = TempDir::new().unwrap();
        let wt = wt_home.path().join("linked");
        git(
            t.path(),
            &["worktree", "add", "-q", "-b", "wt", wt.to_str().unwrap()],
        );
        assert!(
            wt.join(".git").is_file(),
            "夹具必须是 linked worktree（.git 为文件）"
        );
        let rw = GitRepo::open(&wt).unwrap();
        assert_eq!(rw.root, wt);
        assert_ne!(rw.gitdir, wt.join(".git"));
        assert_eq!(
            rw.gitdir,
            t.path().join(".git").join("worktrees").join("linked")
        );
        assert!(rw.gitdir.join("HEAD").is_file(), "per-worktree HEAD 应存在");
        assert_gitdir_equivalent(&wt, &rw);
    }

    #[test]
    fn read_operation_five_states_from_gitdir() {
        let t = repo();
        commit_file(t.path(), "a.txt", "1\n", "base");
        let r = GitRepo::open(t.path()).unwrap();
        let g = r.gitdir.clone();
        assert_eq!(read_operation(&r), None);

        // 文件形态：MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD
        for (name, op) in [
            ("MERGE_HEAD", Operation::Merge),
            ("CHERRY_PICK_HEAD", Operation::CherryPick),
            ("REVERT_HEAD", Operation::Revert),
        ] {
            fs::write(g.join(name), "0".repeat(40)).unwrap();
            assert_eq!(read_operation(&r), Some(op), "{name}");
            fs::remove_file(g.join(name)).unwrap();
            assert_eq!(read_operation(&r), None, "{name} 清理后");
        }

        // 目录形态：rebase-merge / rebase-apply
        for name in ["rebase-merge", "rebase-apply"] {
            fs::create_dir_all(g.join(name)).unwrap();
            assert_eq!(read_operation(&r), Some(Operation::Rebase), "{name}");
            fs::remove_dir_all(g.join(name)).unwrap();
            assert_eq!(read_operation(&r), None, "{name} 清理后");
        }

        // 变基优先于 HEAD 类探测（变基中途 HEAD 分离，其它探测会误报）
        fs::write(g.join("MERGE_HEAD"), "0".repeat(40)).unwrap();
        fs::create_dir_all(g.join("rebase-merge")).unwrap();
        assert_eq!(read_operation(&r), Some(Operation::Rebase));
        fs::remove_dir_all(g.join("rebase-merge")).unwrap();
        fs::remove_file(g.join("MERGE_HEAD")).unwrap();
        assert_eq!(read_operation(&r), None);
    }

    /// 本改动唯一的语义风险点：linked worktree 的中间态落在 per-worktree gitdir。
    #[test]
    fn operation_state_in_linked_worktree_is_per_worktree() {
        let t = repo();
        commit_file(t.path(), "a.txt", "base\n", "base");
        let wt_home = TempDir::new().unwrap();
        let wt = wt_home.path().join("linked");
        git(
            t.path(),
            &["worktree", "add", "-q", "-b", "wt", wt.to_str().unwrap()],
        );
        // 两侧各向前走一步 → 真合并冲突
        fs::write(t.path().join("a.txt"), "main\n").unwrap();
        git(t.path(), &["commit", "-q", "-am", "main side"]);
        fs::write(wt.join("a.txt"), "wt\n").unwrap();
        git(&wt, &["commit", "-q", "-am", "wt side"]);
        let merge = Command::new("git")
            .current_dir(&wt)
            .args(["merge", "main"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "夹具必须真冲突");

        let r_main = GitRepo::open(t.path()).unwrap();
        let r_wt = GitRepo::open(&wt).unwrap();
        // git 把 MERGE_HEAD 写在 linked worktree 的 gitdir，主仓库 .git 里没有
        assert!(r_wt.gitdir.join("MERGE_HEAD").is_file());
        assert!(!t.path().join(".git").join("MERGE_HEAD").exists());
        assert_eq!(read_operation(&r_wt), Some(Operation::Merge));
        assert_eq!(read_operation(&r_main), None);
        let st_wt = get_status(&r_wt).unwrap();
        assert_eq!(st_wt.operation, Some(Operation::Merge));
        assert!(st_wt.unmerged.iter().any(|f| f.path == "a.txt"));
        let st_main = get_status(&r_main).unwrap();
        assert_eq!(st_main.operation, None);
        assert!(st_main.unmerged.is_empty());

        // 手工造 rebase-merge 于 per-worktree gitdir：主仓库看不到，且与 --git-path 同址
        fs::create_dir_all(r_wt.gitdir.join("rebase-merge")).unwrap();
        assert_eq!(read_operation(&r_wt), Some(Operation::Rebase));
        assert_eq!(
            git_path_probe(&wt, "rebase-merge"),
            r_wt.gitdir.join("rebase-merge")
        );
        assert_eq!(read_operation(&r_main), None);
    }

    #[test]
    fn parse_detail_head_with_and_without_multiline_body() {
        let t = repo();
        let root_commit = commit_file(t.path(), "a.txt", "1\n", "subject only");
        fs::write(t.path().join("b.txt"), "2\n").unwrap();
        git(t.path(), &["add", "--", "b.txt"]);
        let msg = t.path().join("msg.txt");
        fs::write(&msg, "subject with body\n\nline one\nline two\n").unwrap();
        git(t.path(), &["commit", "-q", "-F", msg.to_str().unwrap()]);
        let head = git(t.path(), &["rev-parse", "HEAD"]).trim().to_string();
        let r = GitRepo::open(t.path()).unwrap();

        // 无 body：`%b` 为空
        let d0 = get_commit_detail(&r, &root_commit).unwrap();
        assert_eq!(d0.meta.id, root_commit);
        assert_eq!(d0.meta.subject, "subject only");
        assert_eq!(d0.meta.parents.len(), 0);
        assert_eq!(d0.body, "");
        assert!(d0
            .patch
            .as_deref()
            .unwrap()
            .starts_with("diff --git a/a.txt b/a.txt"));

        // 多行 body：完整保留（含段落）
        let d1 = get_commit_detail(&r, &head).unwrap();
        assert_eq!(d1.meta.id, head);
        assert_eq!(d1.meta.subject, "subject with body");
        assert_eq!(d1.body, "line one\nline two");
        assert_eq!(d1.files.len(), 1);
        assert_eq!(d1.files[0].status, 'A');
        assert_eq!((d1.files[0].add, d1.files[0].del), (1, 0));

        // DETAIL_FORMAT 的形态：8 个字段 + body，body 在最后一段
        let raw = git(
            t.path(),
            &["show", "-s", &format!("--format={DETAIL_FORMAT}"), &head],
        );
        let (meta, body) = parse_detail_head(&raw).unwrap();
        assert_eq!(meta.id, head);
        assert_eq!(meta.short_id, head[..7].to_string());
        assert_eq!(body, "line one\nline two");
    }

    /// `--raw --numstat --patch` 合并解析：状态字母 / 增删计数 / 二进制 / 重命名 /
    /// patch 段落切分，并与改造前「name-status + numstat + show --patch」的产出等价。
    #[test]
    fn show_raw_numstat_patch_files_equivalent_to_v1() {
        let t = repo();
        commit_file(t.path(), "mod.txt", "1\n", "base");
        commit_file(t.path(), "old.txt", "rename me\n", "base rename");
        commit_file(t.path(), "del.txt", "gone\n", "base delete");
        commit_file(t.path(), "colon.txt", "first\n", "base colon");
        // 第二条提交：M + R + D + A（文本）+ A（二进制）
        fs::write(t.path().join("mod.txt"), "2\n").unwrap();
        git(t.path(), &["mv", "old.txt", "new.txt"]);
        fs::remove_file(t.path().join("del.txt")).unwrap();
        git(t.path(), &["rm", "-q", "--", "del.txt"]);
        // patch 正文里刻意放一行以 `:` 开头，检验 raw/numstat 段切分不会被正文污染
        fs::write(t.path().join("colon.txt"), "first\n:not a raw line\n").unwrap();
        fs::write(t.path().join("bin.dat"), [0u8, 1, 2, 0, 255]).unwrap();
        git(t.path(), &["add", "--", "mod.txt", "colon.txt", "bin.dat"]);
        git(t.path(), &["commit", "-q", "-m", "mixed changes"]);
        let head = git(t.path(), &["rev-parse", "HEAD"]).trim().to_string();

        let r = GitRepo::open(t.path()).unwrap();
        let d = get_commit_detail(&r, &head).unwrap();
        assert_eq!(d.files.len(), 5, "{:?}", d.files);
        let f = |p: &str| {
            d.files
                .iter()
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("缺 {p}：{:?}", d.files))
        };
        assert_eq!(f("mod.txt").status, 'M');
        assert_eq!((f("mod.txt").add, f("mod.txt").del), (1, 1));
        assert!(f("mod.txt").old_path.is_none());
        assert_eq!(f("new.txt").status, 'R');
        assert_eq!(f("new.txt").old_path.as_deref(), Some("old.txt"));
        assert_eq!(f("del.txt").status, 'D');
        assert_eq!(f("colon.txt").status, 'M');
        assert_eq!((f("colon.txt").add, f("colon.txt").del), (1, 0));
        assert_eq!(f("bin.dat").status, 'A');
        assert!(f("bin.dat").binary);
        assert_eq!((f("bin.dat").add, f("bin.dat").del), (0, 0));

        // patch 从首个 `diff --git` 起：正文里的 `:` 行不会被吞进 raw/numstat 段
        let patch = d.patch.as_deref().unwrap();
        assert!(patch.starts_with("diff --git "), "{patch}");
        assert_eq!(patch.matches("diff --git ").count(), 5, "{patch}");
        assert!(patch.contains(":not a raw line"), "{patch}");
        assert_eq!(d.meta.subject, "mixed changes");
        assert_eq!(d.body, "");

        // 与改造前三条命令的产出等价：files 逐字段、patch 逐行
        let ns = git(
            t.path(),
            &["show", "--format=", "--name-status", "-M", &head],
        );
        let num = git(t.path(), &["show", "--format=", "--numstat", "-M", &head]);
        let statuses = name_status_v1_for_test(&ns);
        let old_files: Vec<FileStat> = parse_numstat(&num)
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
        assert_eq!(stat_snapshot(&d.files), stat_snapshot(&old_files));
        let old_patch = git(t.path(), &["show", "--format=", "--patch", &head]);
        assert_eq!(
            patch.lines().collect::<Vec<_>>(),
            old_patch.lines().collect::<Vec<_>>()
        );
    }

    /// `--raw` 的 R/C 记录是 `R100\t<source>\t<destination>`（源在前、目标在后）。
    #[test]
    fn show_raw_rename_paths_are_source_then_destination() {
        let t = repo();
        commit_file(t.path(), "old.txt", "rename me\n", "base");
        commit_file(t.path(), "other.txt", "other\n", "base other");
        git(t.path(), &["mv", "old.txt", "new.txt"]);
        fs::write(t.path().join("other.txt"), "changed\n").unwrap();
        git(t.path(), &["add", "--", "other.txt"]);
        git(t.path(), &["commit", "-q", "-m", "rename + modify"]);
        let head = git(t.path(), &["rev-parse", "HEAD"]).trim().to_string();

        // 先钉住 git 的输出方向：raw 段写 `<old>\t<new>`，patch 段写 rename from/to
        let raw = git(t.path(), &["show", "--format=", "--raw", "-M", &head]);
        assert!(raw.contains("R100\told.txt\tnew.txt"), "{raw}");
        let patch = git(t.path(), &["show", "--format=", "--patch", &head]);
        assert!(patch.contains("rename from old.txt"), "{patch}");
        assert!(patch.contains("rename to new.txt"), "{patch}");

        // 解析结果：path = 新路径、old_path = 原路径（与 numstat 的 `old => new` 同向）
        let r = GitRepo::open(t.path()).unwrap();
        let d = get_commit_detail(&r, &head).unwrap();
        let by = |p: &str| {
            d.files
                .iter()
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("缺 {p}：{:?}", d.files))
        };
        assert_eq!(d.files.len(), 2, "{:?}", d.files);
        assert_eq!(by("new.txt").status, 'R');
        assert_eq!(by("new.txt").old_path.as_deref(), Some("old.txt"));
        assert_eq!(by("other.txt").status, 'M');
        assert!(by("other.txt").old_path.is_none());

        // 解析器直测：合成一份形态取自真实输出的 raw + numstat + patch
        let synthetic = concat!(
            ":100644 100644 6e91814 6e91814 R100\told.txt\tnew.txt\n",
            "0\t0\told.txt => new.txt\n",
            ":100644 100644 db127bf f0abfbc M\tother.txt\n",
            "1\t1\tother.txt\n",
            "\n",
            "diff --git a/old.txt b/new.txt\n",
            "rename from old.txt\n",
            "rename to new.txt\n",
        );
        let (files, patch) = parse_show_raw_numstat_patch(synthetic);
        assert_eq!(files.len(), 2, "{files:?}");
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[0].status, 'R');
        assert_eq!(files[1].path, "other.txt");
        assert_eq!(files[1].status, 'M');
        assert!(patch.unwrap().starts_with("diff --git a/old.txt b/new.txt"));
    }

}

