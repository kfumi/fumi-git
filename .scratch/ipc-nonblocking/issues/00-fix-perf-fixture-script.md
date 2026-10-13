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
- `emit_commit`：`data ${#2}` 恰好等于消息正文的字节数（`echo "$2"` 多出的那个换行是 `data` 块的**可选结束换行**：`data SP <count> LF <raw> LF?`，属块语法、不计入 `<count>`），所以能跑通 ✓ —— 仍然**不要**改成 `${#2}+1`。

**换行注意**：该文件在工作区是 CRLF。首轮排查中 CRLF 与 LF 两种检出下**都**实测失败（同一报错），
说明 `echo` 在两种情况下都只输出 15 字节，`data 15` 是两种换行下都正确的最小修法。
不要引入 `printf` / `sed` / 重写脚本等额外改动。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] `bash scripts/gen-perf-repo.sh <临时目录> 1000` 退出码 0，且目标目录无 `fast_import_crash_*`
- [x] `git -C <临时目录> rev-list --count --all` = **1001**（800 主干 + 200 feat + 1 合并）
- [x] 合并连接真实存在：`git -C <目录> log --merges --oneline refs/heads/main` 计数 = **1**，且该合并的**第二父提交 = `refs/heads/feat` 的 tip**（`git -C <目录> log --merges --format='%P' -1 refs/heads/main` 的第二个哈希 == `git -C <目录> rev-parse refs/heads/feat`；配套上一条）。理由：`rev-list --count --all` = 1001 对「merge 是否真接上」不敏感（合并断了也仍是 1001），而 01 / 03 把这套夹具当提交图谱渲染，故单列此条。
- [x] `git -C <临时目录> for-each-ref --format='%(refname)'` 含 `refs/heads/main` 与 `refs/heads/feat`
- [x] 默认参数（10 万提交）能生成完，耗时与仓库体积记入 Comments
- [x] 把脚本转成 CRLF 后重跑一次仍退出码 0（`unix2dos` 或将内容用 `[IO.File]::WriteAllText` 以 CRLF 写回）
- [x] `git diff --stat e4e9dfc..c464e37 -- scripts/gen-perf-repo.sh` = `1 file changed, 2 insertions(+), 2 deletions(-)`，且无行尾重写 / 无整文件重写。**本判据由控制器在 `d772b8b` 修改（裁决 D3）**：原文写「只有 1 行」，前提是「只有一处缺陷」，该前提已被实测推翻（见 Comments 第 2 处）；判据依据是 spec「前置」的绑定意图 —— 夹具必须能生成，只改一处则验收 1/2/3/4/5 条全部无法达成。判据既由改动方修改，就由**作者以外的人独立验证后勾选** —— 控制器已独立验证（见 Comments 末节）。`-- scripts/gen-perf-repo.sh` 这一路径限定是必需的（不加会连工单 / spec 文本一并计入）。

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

**评审 1 轮整改（文档口径，未改脚本）**

- 验收第 6 条改为**路径限定 + 未勾选**，留待作者以外的人验证。实测命令与输出：

```
$ git diff --stat e4e9dfc..HEAD -- scripts/gen-perf-repo.sh
 scripts/gen-perf-repo.sh | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)
```

对照（不加路径限定，两端钉定以免数字随文档提交漂移）：`git diff --stat e4e9dfc..d772b8b` = `3 files changed, 27 insertions(+), 12 deletions(-)`（连工单与 spec 文本一起计入），故第 6 条判据必须限定到脚本路径。

- 新增合并连接断言，两个夹具均实测：
  - 保留的 10 万夹具 `C:\Users\kuangdi\.pi-desktop\scratch\3c411be3-c0cc-4488-95f2-1c7dbc9124f7\perf-repo-script`：`git log --merges --oneline refs/heads/main` = 1 行；`git log --merges --format='%P' -1 refs/heads/main` = `70e14260f23ac31893169d65d68c740103ad3de6 15ff049dc6c8990877d819c5731a83e85a080555`，第二父 `15ff049dc6c8990877d819c5731a83e85a080555` == `git rev-parse refs/heads/feat` ✓；`rev-list --count --all` = 100001。
  - 新跑的 1000 提交（`mergecheck-1000`，退出码 0）：`rev-list --count --all` = 1001；`git log --merges --oneline refs/heads/main` = 1 行；`git log --merges --format='%P' -1 refs/heads/main` = `d22ba25a6126b45a23865986a74a6ca12553a4ca d115d4547cb40473ea483ba767cd864f4fc3f68c`，第二父 `d115d4547cb40473ea483ba767cd864f4fc3f68c` == `git rev-parse refs/heads/feat` ✓。
  - **评审建议的第一种写法 `git -C <目录> rev-parse --verify --quiet refs/heads/main^2` 在本夹具形状下不成立**（两处实测都无输出、退出码 1）：脚本在合并之后继续往 main 追加提交，`refs/heads/main` 的 tip 只有 1 个父提交（10 万夹具：`git show -s --format='%H %P' refs/heads/main` = `46c033519b987fab2fccfa39bb15724b19f8b410` + 单父 `bede7ca4c78ac0dcfd2d949e75c41e8d323a4b97`），合并提交 `5985508cb044d80bb42283857b37443798495d0a` 是它的祖先而非它本身。故采用评审给出的替代形式（merges 计数 + 第二父交叉校验）。

- `emit_commit` 的 `data ${#2}` 说明改口径：`${#2}` 恰等于正文字节数，`echo "$2"` 多出的换行是 `data` 块的可选结束换行（`data SP <count> LF <raw> LF?`），不是「被当空行忽略」的多余字节；结论不变（不要改成 `${#2}+1`）。
- `spec.md` 的「前置」补上第二处改动（原只记 `data 16` → `data 15`），与 `d772b8b` 已改的工单「改动范围」对齐。

**控制器独立验证（第 6 条的验证者记录，在 `c464e37` 上，验证者非作者）**

```
$ git diff --stat e4e9dfc..c464e37 -- scripts/gen-perf-repo.sh
 scripts/gen-perf-repo.sh | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)
$ git diff --numstat e4e9dfc..c464e37 -- scripts/gen-perf-repo.sh
2       2       scripts/gen-perf-repo.sh
```

- 无行尾重写：工作区文件仍 **76 个 CRLF 对 / 2162 字节**（与改前一致，仅少一个被删的 `:`），`git show HEAD:scripts/gen-perf-repo.sh` 为纯 LF。
- 脚本自 `a231e55` 起逐字节未变：`git diff --stat a231e55..HEAD -- scripts/gen-perf-repo.sh` 无输出。
- 控制器另行**独立重跑**夹具（第二方证据，不引用实现者输出）：`bash scripts/gen-perf-repo.sh <scratch>\ctl-verify-1000 1000` → 退出码 0、无 `fast_import_crash_*`、`rev-list --count --all` = **1001**、refs = `feat` + `main`、`git log --merges` = **1**；保留的 10 万夹具实测 `count` = **100001**、合并结论相同。
