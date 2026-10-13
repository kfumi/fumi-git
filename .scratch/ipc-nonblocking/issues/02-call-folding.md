# 02 — 调用折叠：14 个 git 进程 → 一轮 refresh 6 个

**What to build:** 把「值得 spawn 的 git 调用」压到最少，并把每条调用换成一次拿全信息的输出格式。
一轮 `refresh()` 触发的进程从 **14 个降到 6 个**（`list_remotes` 保留），
`read_operation` 与 `get_branch_summary` 的 `symbolic-ref`/`rev-parse @{u}`/`rev-list` 全部消失。
**`RepoStatus` 的分组语义、`FileEntry.status` 单字符、`GitError` 形状、命令签名一律不变。**

调用次数对照（现状 → 目标）：

| 命令 | 现状 | 目标 |
|---|---|---|
| `get_status` | 7（status + 5×read_operation + symbolic-ref） | **1**（分离 HEAD 时 2） |
| `get_branch_summary` | 3 | **1** |
| `get_commit_detail` | 5 | **2** |
| `get_compare` | 5 | **4** |
| 一轮 `refresh()` 合计 | 14 | **6** |

## 1) `GitRepo` 增 `gitdir`，`open()` 一次拿两个路径

```rust
#[derive(Clone)]
pub struct GitRepo {
    /// `rev-parse --show-toplevel` 归一化的仓库根
    pub root: PathBuf,
    /// `rev-parse --absolute-git-dir`：MERGE_HEAD / rebase-merge 等中间态的锚点。
    /// linked worktree 下 `.git` 是**文件**而不是目录，所以必须问 git 要，不能硬拼 root/.git。
    pub gitdir: PathBuf,
}
```

`open()` 里把 `rev-parse --show-toplevel` 换成 **一次调用拿两行**（已实测：两条输出行，
子目录打开也正确；`--absolute-git-dir` 自 git 2.13 起可用，本机 2.35.1）：

```rust
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
```

失败分支（`rev-parse --is-bare-repository` → 裸仓库 / 非仓库两种错误）**保持原样不动**。

## 2) `read_operation`：5 次 `rev-parse` → 0 次（文件判定）

```rust
fn read_operation(repo: &GitRepo) -> Option<Operation> {
    // gitdir 已在 open() 解析为绝对路径，这里只做存在性判断
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
```

**等价性依据**：现状用 `rev-parse --git-path <name>` 解析，对 `MERGE_HEAD` / `CHERRY_PICK_HEAD` /
`REVERT_HEAD` / `rebase-merge` / `rebase-apply` 这五个名字，解析结果就是 `<gitdir>/<name>`
（linked worktree 下 gitdir 已是 `.git/worktrees/<name>` 这个 per-worktree 目录）。
**必须用 linked worktree 夹具验证**，这是本改动唯一的语义风险点。

## 3) `get_status` → `status --porcelain=v2 --branch -z`

新增头部解析结构（`pub(crate)` 供本模块内使用）：

```rust
/// v2 `--branch` 头部里我们用得到的两项
pub(crate) struct StatusHeads {
    /// `# branch.head`：常规分支为分支名，分离 HEAD 为 `(detached)`，缺失为 None
    pub head: Option<String>,
    /// `# branch.upstream`：只在有效上游时出现
    pub upstream: Option<String>,
}
```

```rust
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
    let mut heads = StatusHeads { head: None, upstream: None };
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
                unstaged.push(FileEntry { path, old_path: None, status: 'A' });
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
        // 重命名：紧随其后的 NUL 段是原路径（与现有 v1 解析同构）
        let old_path = if tag == '2' && (x == 'R' || x == 'C' || y == 'R' || y == 'C') {
            it.next().map(|s| s.to_string())
        } else {
            None
        };
        if tag == 'u' {
            unmerged.push(FileEntry { path, old_path, status: 'U' });
            continue;
        }
        if x != '.' {
            staged.push(FileEntry { path: path.clone(), old_path: old_path.clone(), status: x });
        }
        if y != '.' {
            unstaged.push(FileEntry { path, old_path, status: y });
        }
    }
    (staged, unstaged, unmerged, heads)
}
```

`branch` 字段必须与现状**逐字相同**（现状：`symbolic-ref --short HEAD` 成功即分支名，
失败则 `rev-parse --short HEAD` → `(HEAD detached at <short>)`，再失败 → `(空仓库)`）：

```rust
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
```

```rust
pub fn get_status(repo: &GitRepo) -> GitResult<RepoStatus> {
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
```

## 4) `get_branch_summary` → 复用同一次 v2 输出（3 → 1）

```rust
pub fn get_branch_summary(repo: &GitRepo) -> GitResult<BranchSummary> {
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
```

语义等价性（已实测）：`# branch.upstream origin/main` 与 `rev-parse --abbrev-ref --symbolic-full-name @{u}`
输出同一个短名；`# branch.ab +N -M` 与 `rev-list --left-right --count HEAD...<upstream>` 的第一个数是同一侧。
**无有效上游时两者都不出现/都失败 → `upstream: None`、`0/0`，与现状一致。**

## 5) `get_commit_detail`：5 → 2

新增常量（body 放最后，用 `split_once` 切，正文里的分隔符不会被切开）：

```rust
/// 提交详情：LOG_FORMAT 的 8 个字段 + body
const DETAIL_FORMAT: &str = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e%x1f%b";
```

已实测的形态：`<8 个字段，US 分隔><RS><US><body>`。

```rust
/// `show -s --format=DETAIL_FORMAT` → (元信息, body)；元信息复用 get_log 的解析
fn parse_detail_head(raw: &str) -> GitResult<(CommitEntry, String)> {
    let (meta_part, rest) = raw
        .split_once('\u{1e}')
        .ok_or_else(|| GitError::CommandFailed("提交详情格式异常".into()))?;
    let meta = parse_log_output(&format!("{meta_part}\u{1e}"))
        .pop()
        .ok_or_else(|| GitError::CommandFailed("提交不存在".into()))?;
    let body = rest.strip_prefix('\u{1f}').unwrap_or(rest).trim().to_string();
    Ok((meta, body))
}
```

`--raw --numstat --patch` 的合并解析（两处复用：详情与比较）。**先复用既有 `parse_numstat`
拿文件顺序与计数，再用 `--raw` 覆盖权威 status / old_path，最后按首个 `diff --git` 行切出 patch**：

```rust
/// `--format= --raw --numstat [--patch] -M` 的输出 → (files, patch)
///
/// 输出顺序（实测）：`:` 开头的 raw 段 → numstat 段 → （可选）patch 段。
/// `--raw` 的形态：`:oldmode newmode oldsha newsha <STATUS>\t<path>`，重命名为
/// `R100\t<old>\t<new>`；numstat 的重命名形态是 `0\t0\t<old> => <new>`（两者不同，
/// 既有 parse_numstat 已能同时处理）。
fn parse_show_raw_numstat_patch(raw: &str) -> (Vec<FileStat>, Option<String>) {
    let patch_at = raw.lines().position(|l| l.starts_with("diff --git "));
    let (body, patch) = match patch_at {
        Some(i) => {
            let mut it = raw.lines();
            let head: Vec<&str> = it.by_ref().take(i).collect();
            (head.join("\n"), Some(raw.lines().skip(i).collect::<Vec<_>>().join("\n")))
        }
        None => (raw.to_string(), None),
    };
    let numstat_part: String = body
        .lines()
        .filter(|l| !l.starts_with(':'))
        .collect::<Vec<_>>()
        .join("\n");
    let mut files = parse_numstat(&numstat_part);
    // --raw 是权威：status 字母 + 重命名的原路径
    let mut raw_map = std::collections::HashMap::new();
    for line in body.lines().filter(|l| l.starts_with(':')) {
        let (meta, paths) = match line[1..].split_once('\t') {
            Some(v) => v,
            None => continue,
        };
        let status = meta.rsplit(' ').next().and_then(|s| s.chars().next()).unwrap_or('M');
        let mut seg = paths.split('\t');
        let new_path = seg.next().unwrap_or_default().to_string();
        let old_path = seg.next().map(str::to_string);
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
```

```rust
pub fn get_commit_detail(repo: &GitRepo, hash: &str) -> GitResult<CommitDetail> {
    let safe = hash.trim();
    if safe.is_empty() || !safe.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::CommandFailed("非法提交哈希".into()));
    }
    let meta_raw = repo.run(&["show", "-s", &format!("--format={DETAIL_FORMAT}"), safe])?;
    let (meta, body) = parse_detail_head(&meta_raw)?;
    // 合并提交不产出 patch（保持现状语义：patch = None），因此连 --patch 都不传
    let mut args: Vec<&str> = vec!["show", "--format=", "--raw", "--numstat", "-M"];
    if meta.parents.len() <= 1 {
        args.push("--patch");
    }
    args.push(safe);
    let raw = repo.run(&args)?;
    let (files, patch) = parse_show_raw_numstat_patch(&raw);
    Ok(CommitDetail { meta, body, files, patch })
}
```

## 6) `get_compare`：5 → 4

```rust
    let range = format!("{base}..{head}");
    let raw = repo.run(&["diff", "--raw", "--numstat", "--patch", &range])?;
    let (files, patch) = parse_show_raw_numstat_patch(&raw);
```

已实测 `git diff` 与 `git show` 的段序一致（raw → numstat → patch），无差异时整段输出为空 → `patch: None`。
`resolve_compare_ref` 保留不动（`HEAD` / `@` 仍需一次 `rev-parse`）。

## 7) 删除 `parse_name_status`

`--raw` 已提供权威 status，`parse_name_status` 与它在 `get_commit_detail` 里的 statuses 覆盖逻辑
一并删除（`parse_name_status` 只被这一处使用）。

## 8) 测试（`git.rs` 的 `mod tests`，真实 git 夹具）

- **v1/v2 对照（本票最强的回归证据）**：把现有 v1 解析逻辑原样搬进测试模块
  （`parse_status_v1_for_test`），在同一夹具上分别跑 `status --porcelain -z` 与
  `status --porcelain=v2 --branch -z`，断言两次解析出的 `staged / unstaged / unmerged`
  **逐位相等**。夹具覆盖：普通修改、已暂存新增、已暂存删除、重命名（`git mv`）、
  未跟踪文件、冲突（制造 unmerged）、忽略文件（不传 `--ignored` 时应无差异）。
- `branch` 字符串：常规分支 / 分离 HEAD（断言等于 `format!("(HEAD detached at {})", rev-parse --short HEAD)`）/ 空仓库（无提交）/ 有有效上游（含 `# branch.ab +N -M` 的 N/M 对账）
- `read_operation`：夹具手工造 `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` /
  `rebase-merge/` / `rebase-apply/` 五种中间态各自命中；都不存在为 `None`
- gitdir：正常仓库、子目录打开、`git worktree add` 出的 linked worktree（`.git` 为文件）三种入口
- `--raw --numstat --patch` 解析：状态字母、增删计数、二进制（`-\t-`）、重命名（`R100\told\tnew`）、
  patch 段落切分；并与改造前的 `get_commit_detail` 产出等价（元信息 / body / files / patch）
- `parse_detail_head`：有 body、无 body、body 含多行三种
- **类型同步**：`commands.rs` 测试里的 `GitRepo { root }` 字面量补上 `gitdir`（工单 01 留下的）

**Blocked by:** 01（`commands.rs` 的类型同步依赖它先落地）

**Status:** ready-for-agent

- [ ] `cargo test -- --test-threads=1` 全绿：既有用例语义不变 + 上述新增用例
- [ ] v1/v2 对照用例通过；**反向验证有效**：把 v2 解析里 `y != '.'` 改成 `y != ' '` 即变红
- [ ] `get_status` ≤ 1 次 git 调用（分离 HEAD 时 2）、`get_branch_summary` ≤ 1、`get_commit_detail` = 2、`get_compare` = 4（核对方式：在 `spawn_git` 里临时把参数行追加写到一个计数文件，触发一次刷新后数行数，走查完删除临时打印；数字记入 Comments）
- [ ] 一轮 `refresh()` = **6** 个 git 进程（log / status-v2 / summary / stash / refs / remotes）
- [ ] `parse_name_status` 与 statuses 覆盖逻辑已删除（`grep -c parse_name_status` = 0）
- [ ] 端到端：刷新墙钟与手动跑同样 6 条 git 命令同量级

**Comments**

（执行时回填：进程计数、墙钟、commit hash）
