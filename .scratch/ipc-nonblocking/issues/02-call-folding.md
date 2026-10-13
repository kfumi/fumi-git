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

- [x] `cargo test -- --test-threads=1` 全绿：既有用例语义不变 + 上述新增用例 —— `test result: ok. 66 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 437.34s`（57 既有 + 9 新增；既有用例一行未改；`cargo check --all-targets` 0 warning）
- [x] v1/v2 对照用例通过；**反向验证有效**：把 v2 解析里 `y != '.'` 改成 `y != ' '` 即变红 —— 实测变红（RED 原文见 Comments），恢复后文件逐字节回到破坏前状态（tag hash 相同），破坏态从未 `git add`
- [x] `get_status` ≤ 1 次 git 调用（分离 HEAD 时 2）、`get_branch_summary` ≤ 1、`get_commit_detail` = 2、`get_compare` = 4 —— 实测 **1 / 1 / 2 / 3 / 4**（`get_compare` 分别为「两端十六进制 id」= 3 与「base 为字面量 `HEAD`」= 4，后者才是右栏「与 HEAD 比较」的真实形态）；分离 HEAD 的 `get_status` = 2。逐条原始计数见 Comments
- [x] 一轮 `refresh()` = **6** 个 git 进程（log / status-v2 / summary / stash / refs / remotes）—— 构成证明 + 实测：这 6 条命令各 1 次。**如实披露**：`refresh()` 还会调 `getUserIdentity()` → 2 次 `git config --get`，该 2 次在本票的 14 基线里同样未计入（既有行为、本次未改）；按「一次 refresh 的全部 git 进程」计是 **16 → 8**。详见 Comments
- [x] `parse_name_status` 与 statuses 覆盖逻辑已删除（`grep -c parse_name_status` = 0）—— `git show 48eb976:src-tauri/src/git.rs` 上计数 = 0（测试里的等价对照基线改名 `name_status_v1_for_test`，不含该串；`statuses` 覆盖逻辑随 `get_commit_detail` 重写消失）
- [ ] 端到端：刷新墙钟与手动跑同样 6 条 git 命令同量级。（控制器联合端到端验收时勾选 —— ledger 裁决 R2）

**Comments**

**执行记录**（PowerShell 7 / cargo 1.97.1 / git 2.35.1.windows.2）

**代码提交**：`48eb976`（`refactor(git): status v2 + gitdir 缓存 + show/diff 输出合一，一轮刷新 14→6 进程（工单 02）`）——只含 `src-tauri/src/git.rs`（+839/−136）与 `src-tauri/src/commands.rs`（+1，`#[cfg(test)] mod tests` 里 `dummy_repo()` 的 `GitRepo` 字面量补 `gitdir`）；`lib.rs` / `watcher.rs` / 前端一行未动，无命令签名或返回类型变更。本工单文本随后以 `docs(tickets)` 提交收口（工单要写下代码提交 hash，故拆两个提交）。完整报告（未入 git）：`.superpowers/sdd/ipc-nonblocking/task-02-report.md`。

**实现要点**：`GitRepo` 增 `gitdir`，`open()` 用一次 `rev-parse --show-toplevel --absolute-git-dir` 拿两行（失败分支原样保留）。`read_operation` 改为纯文件判定（0 次 git 调用）。`get_status` 走 `status --porcelain=v2 --branch -z`，`get_branch_summary` 复用同一次输出（`# branch.upstream` / `# branch.ab`）。`get_commit_detail` 合并成 2 次调用（`show -s --format=DETAIL_FORMAT` + `show --format= --raw --numstat -M [--patch]`），`get_compare` 用 `diff --raw --numstat --patch`。`parse_name_status` 与 statuses 覆盖逻辑删除，`is_unmerged` 随 v1 解析一起搬进测试模块（生产路径无死代码，0 warning）。

**进程计数**（方法：在 `spawn_git` 里临时把「实际命令行」追加写 `%TEMP%\fumigit_proc_count.txt`，逐条命令「清空 → 执行 → 数行」，由一条临时 `#[test]` 驱动；走查后插桩与临时用例已删除，`git.rs` 恢复到插桩前的逐字节状态）：

```
get_status = 1                # git status --porcelain=v2 --branch -z
get_branch_summary = 1        # git status --porcelain=v2 --branch -z
get_commit_detail(hex) = 2    # show -s --format=DETAIL_FORMAT <h> + show --format= --raw --numstat -M --patch <h>
get_compare(hex,hex) = 3      # diff --raw --numstat --patch <b>..<h> + show -s <b> + show -s <h>
get_compare(HEAD,hex) = 4     # 以上 + git rev-parse HEAD
get_log_filtered(default) = 1 # git log --topo-order --skip=0 --max-count=50 --format=… --all
get_log_filtered(branch) = 2  # rev-parse --verify refs/heads/main^{commit} + log refs/heads/main（既有行为，未改）
list_refs = 1                 # git for-each-ref …
list_remotes = 1              # git remote
stash_list = 1                # git stash list --format=%gd%x1f%gs%x1f%ct
get_user_identity = 2         # git config --get --default= user.name / user.email
get_status(detached) = 2      # status + rev-parse --short HEAD（branch_from_heads 的分离 HEAD 回退）
```

**「6」的构成**（按 `src/stores/repo.ts:1181-1194` 的 `refresh()` 实际调用顺序，默认日志筛选 `--all`）：`getLog`(1) + `getStatus`(1) + `getBranchSummary`(1) + `stashList`(1) + `listRemotes`(1) + `listRefs`(1) = **6**；上表逐条实测为 1，故 6 成立。同一序列在本机**端到端实测总数 = 8**，多出的 2 次是 `refresh()` 里 `getUserIdentity()` 的两条 `git config --get` —— 它在本票的 14 基线表里同样没有计入（14 = status 7 + summary 3 + log 1 + stash 1 + remotes 1 + refs 1），本次也未改动；按「一次 refresh 的全部 git 进程」口径即 **16 → 8**。运行期确认（真实 `refresh()` 触发）按 ledger 裁决留给控制器联合端到端验收。

**反向验证（RED → 恢复后 GREEN）**：

```
$ cargo test --quiet -- --test-threads=1 status_v1_and_v2_parsers_agree_bit_for_bit   # v2 解析临时改成 y != ' '
running 1 test
git::tests::status_v1_and_v2_parsers_agree_bit_for_bit --- FAILED
thread 'git::tests::status_v1_and_v2_parsers_agree_bit_for_bit' (32904) panicked at src\git.rs:3726:9:
assertion `left == right` failed: unstaged 组不一致
  left: [("mod.txt", None, 'M'), ("untracked.txt", None, 'A')]
 right: [("added.txt", None, '.'), ("mod.txt", None, 'M'), ("renamed.txt", Some("keep.txt"), '.'), ("rm.txt", None, '.'), ("untracked.txt", None, 'A')]
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 66 filtered out; finished in 6.33s
```

（`y != ' '` 会把 `Y='.'` 的「未改动」条目灌进 unstaged；恢复 `y != '.'` 后同命令 `test result: ok. 1 passed`。之所以能测到：夹具里 `added.txt / renamed.txt / rm.txt` 都是「暂存侧有改动、工作区侧未改动」，正是这一位。）

**新增用例 9 条**（全部真实 git 夹具，不 mock）：v1/v2 逐位对照（七形态同盘：普通修改 / 已暂存新增 / 已暂存删除 / `git mv` 重命名 / 未跟踪 / 真实合并冲突 unmerged / 忽略文件）；`branch` 三态（常规 / 分离 HEAD 与 `rev-parse --short HEAD` 对齐 / 空仓库）；上游与 `# branch.ab` 同 `rev-list --left-right --count` 双面对账（2/1 分叉）；`read_operation` 五态各自命中 + 都不存在为 `None` + 变基优先；gitdir 三入口（根 / 子目录 / `git worktree add` 的 linked worktree，`.git` 为文件）并断言五个名字上 `<gitdir>/<name>` 与 `rev-parse --git-path` 解析结果逐条相等；linked worktree 真实合并冲突（`MERGE_HEAD` 落在 per-worktree gitdir，主仓库 `.git` 看不到）；`parse_detail_head` 有/无/多行 body + 根提交仍给 patch；`--raw --numstat --patch` 解析（状态字母、增删计数、二进制 `-	-`、`R100` 重命名、patch 段切分，hunk 正文里以 `:` 开头的行不被吞）并与改造前 `name-status + numstat + show --patch` 三条命令的产出**逐字段 / 逐行等价**；`--raw` 重命名方向（源在前目标在后，并用同一 diff 的 patch 段 `rename from/to` 互证）。

**两处自觉偏差（如实披露）**

1. `parse_show_raw_numstat_patch` 的 `--raw` 重命名段序：工单代码段把第一段当**新**路径（`new_path = seg.next()`），但工单自己的注释写的是 `R100\t<old>\t<new>`，实测 git 2.35.1 也是**源在前、目标在后**（同一 diff 的 patch 段写着 `rename from old.txt / rename to new.txt`，numstat 是 `0\t0\told.txt => new.txt`）。我按实测方向实现（第一段 = 原路径、第二段 = 新路径），让「`--raw` 是权威：status 字母 + 重命名的原路径」这个既定意图真正成立。**可观测性实验**：临时改回工单原样段序后 `show_raw*` / `status*` 用例全绿 —— 两者在真实 git 输出下行为等价（重命名的源路径不可能同时是同一 diff 里另一条记录的路径），故该偏差不影响任何验收条目，只是让代码与其注释、与 git 实际格式自洽。
2. `get_commit_detail` 的 `patch` 形状保持：非合并提交即使无文件变更也与旧实现同形（`Some("")`），只有合并提交是 `None` —— 前端 `src/components/DiffView.tsx:93` 用 `patch === null` 渲染「合并提交 — 无直接文件变更」，若让空提交也返回 `None` 会显示错文案。这 3 行守卫超出工单代码段，为守住既有前端契约。

**其余既有事实（不在本票范围、无动作）**：`parse_numstat` 对 `dir/{old => new}/f.txt` 这类**部分重命名**的 numstat 形态解析仍不精确（改造前同样如此，本票未引入也未修复）；v2 解析不再对路径做 `trim()`（v1 会 trim），即首尾含空格的路径现在按 git 原样返回，属修正而非回归。另：本机 `cargo check/test` 需要 `rc.exe` 在 PATH（tauri-winres 构建脚本），本次运行显式前置了 Windows SDK 的 x64 目录，与代码无关。

**验证命令与结果**

```
$ cd src-tauri && cargo check --all-targets        # Finished，0 warning
$ cargo test -- --test-threads=1
test result: ok. 66 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 437.34s
$ pnpm test    # 7 files / 164 passed（前端零改动，与基线一致）
$ pnpm build   # tsc + vite build 通过
```
