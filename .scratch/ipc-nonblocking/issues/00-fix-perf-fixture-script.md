# 00 — 修性能夹具脚本（fast-import `data` 长度 off-by-one）

**What to build:** `scripts/gen-perf-repo.sh` 预置 blob 那一行的 `data` 长度与实际输出字节数不符，
脚本在当前检出下必然失败；改成正确长度，让「十万级提交夹具」这条验收前置可用。

**定位**（已用 hexdump 与真实运行证实）：`echo "content v$i pad"` 输出 `content v1 pad` + `\n`
= **15 字节**（14 字符 + 换行），而脚本声明 `data 16`。fast-import 于是多吞掉下一个 `blob` 的首字节 `b`，
下一行读到 `lob` → `fatal: Unsupported command: lob`，并落一个 `.git/fast_import_crash_*`。
`git -C "$TARGET" fast-import --quiet` 因此非 0 退出，`set -euo pipefail` 让整个脚本失败。

**改动范围：两处各一行**（第 20 行的 `data` 长度；第 47 行 `from` 后重复冒号 —— 第二处被第一处掩盖，定位见 Comments）。

```bash
    echo "data 16"
```

改成

```bash
    echo "data 15"
```

同块内其它手写长度已核对无误，**不要**顺手改动：
- merge 提交：`echo "data 11"` + `echo "Merge feat"` = 10 + 1 = 11 ✓
- `emit_commit`：`data ${#2}` 比 `echo "$2"` 的实际输出**少 1 字节**，fast-import 读满声明字节数后把多出的换行当空行忽略，所以能跑通 ✓ —— 仍然**不要**改成 `${#2}+1`。

**换行注意**：该文件在工作区是 CRLF。首轮排查中 CRLF 与 LF 两种检出下**都**实测失败（同一报错），
说明 `echo` 在两种情况下都只输出 15 字节，`data 15` 是两种换行下都正确的最小修法。
不要引入 `printf` / `sed` / 重写脚本等额外改动。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] `bash scripts/gen-perf-repo.sh <临时目录> 1000` 退出码 0，且目标目录无 `fast_import_crash_*`
- [x] `git -C <临时目录> rev-list --count --all` = **1001**（800 主干 + 200 feat + 1 合并）
- [x] `git -C <临时目录> for-each-ref --format='%(refname)'` 含 `refs/heads/main` 与 `refs/heads/feat`
- [x] 默认参数（10 万提交）能生成完，耗时与仓库体积记入 Comments
- [x] 把脚本转成 CRLF 后重跑一次仍退出码 0（`unix2dos` 或将内容用 `[IO.File]::WriteAllText` 以 CRLF 写回）
- [x] `git diff --stat` = **2 行改动**（`1 file changed, 2 insertions(+), 2 deletions(-)`）。原判据写的是「只有 1 行」，那写在「只有一处缺陷」的错误前提上，已被实测推翻（见 Comments 第 2 处与 ledger 裁决 D3）；两处均为一行改动，无行尾重写、无整文件重写。

**Comments**

**执行记录（PowerShell 7 + Git for Windows bash）**

改动：`scripts/gen-perf-repo.sh` 两处各一行（未改 `emit_commit`，未引入 `printf` / `sed` / `awk`，未重写脚本，未动行尾）：

1. 第 20 行 `echo "data 16"` → `echo "data 15"`：`content vN pad` 实际输出 15 字节（14 字符 + 换行），本票定位的那处。
2. 第 47 行 `echo "from :$main_tip"` → `echo "from $main_tip"`：**第 2 处缺陷，被第 1 处掩盖**。`main_tip` 在 55 行赋值时就自带冒号（`main_tip=":$mark"`），此处再加一个 `:` 导致输出 `from ::341` → `fatal: No value after ':' in mark: from ::341`，`.git/fast_import_crash_*` 里该行被 `*` 标为出错行（`* from ::341`）。同块 66/67 行 `from $main_tip` / `merge $feat_tip` 才是既有约定，本次改法与之对齐，不改语义（feat 仍从 `:341` 起）。off-by-one 让流在第一个 blob（`fatal: Unsupported command: lob`）就断掉，根本走不到 `reset refs/heads/feat`，所以此前只看得见第 1 处。

验证（`& "C:\Program Files\Git\bin\bash.exe" scripts/gen-perf-repo.sh <目标目录> [提交数]`）：

- 工作区 CRLF 版本、1000 提交：退出码 **0**，目标目录无 `fast_import_crash_*`，`rev-list --count --all` = **1001**，`for-each-ref` = `refs/heads/feat` + `refs/heads/main`。
- LF 版本、1000 提交：把提交版脚本落盘成 LF 临时文件（实测 0 个 CRLF、76 个 LF、2086 字节）后运行，退出码 **0**，同样 1001 / 两个 ref / 无 crash 文件。工作区文件本身已是 CRLF（76 个 CRLF 对），两种换行都实测通过，未做任何行尾转换。
- 默认参数 10 万提交：退出码 **0**，`rev-list --count --all` = **100001**；墙钟 **25.8 s**；磁盘 **17.14 MiB**（25 个文件共 17,971,172 字节；`git count-objects -vH` → count 0 / in-pack 100007 / packs 1 / size-pack 17.11 MiB）。夹具保留在仓库外的 `C:\Users\kuangdi\.pi-desktop\scratch\3c411be3-c0cc-4488-95f2-1c7dbc9124f7\perf-repo-script`，供 01 / 03 的端到端验收复用，不入库。
- `git diff --stat`：`1 file changed, 2 insertions(+), 2 deletions(-)`，即上面两行。

提交：脚本修复 = `a231e55`（`fix(scripts): 修性能夹具脚本 fast-import data 长度 off-by-one（工单 00）`）；本工单文本随其后的 `docs(tickets)` 提交收口。
