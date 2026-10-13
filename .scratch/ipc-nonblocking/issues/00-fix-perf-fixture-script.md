# 00 — 修性能夹具脚本（fast-import `data` 长度 off-by-one）

**What to build:** `scripts/gen-perf-repo.sh` 预置 blob 那一行的 `data` 长度与实际输出字节数不符，
脚本在当前检出下必然失败；改成正确长度，让「十万级提交夹具」这条验收前置可用。

**定位**（已用 hexdump 与真实运行证实）：`echo "content v$i pad"` 输出 `content v1 pad` + `\n`
= **15 字节**（14 字符 + 换行），而脚本声明 `data 16`。fast-import 于是多吞掉下一个 `blob` 的首字节 `b`，
下一行读到 `lob` → `fatal: Unsupported command: lob`，并落一个 `.git/fast_import_crash_*`。
`git -C "$TARGET" fast-import --quiet` 因此非 0 退出，`set -euo pipefail` 让整个脚本失败。

**改动范围：一行。** `{ ... } | git fast-import --quiet` 块里

```bash
    echo "data 16"
```

改成

```bash
    echo "data 15"
```

同块内其它手写长度已核对无误，**不要**顺手改动：
- merge 提交：`echo "data 11"` + `echo "Merge feat"` = 10 + 1 = 11 ✓
- `emit_commit`：用 `echo "data ${#2}"` 自算长度 ✓

**换行注意**：该文件在工作区是 CRLF。首轮排查中 CRLF 与 LF 两种检出下**都**实测失败（同一报错），
说明 `echo` 在两种情况下都只输出 15 字节，`data 15` 是两种换行下都正确的最小修法。
不要引入 `printf` / `sed` / 重写脚本等额外改动。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] `bash scripts/gen-perf-repo.sh <临时目录> 1000` 退出码 0，且目标目录无 `fast_import_crash_*`
- [ ] `git -C <临时目录> rev-list --count --all` = **1001**（800 主干 + 200 feat + 1 合并）
- [ ] `git -C <临时目录> for-each-ref --format='%(refname)'` 含 `refs/heads/main` 与 `refs/heads/feat`
- [ ] 默认参数（10 万提交）能生成完，耗时与仓库体积记入 Comments
- [ ] 把脚本转成 CRLF 后重跑一次仍退出码 0（`unix2dos` 或将内容用 `[IO.File]::WriteAllText` 以 CRLF 写回）
- [ ] `git diff --stat` 只有 1 行改动

**Comments**

（执行时回填：生成耗时、体积、commit hash）
