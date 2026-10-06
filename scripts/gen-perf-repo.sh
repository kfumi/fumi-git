#!/usr/bin/env bash
# 生成大型性能验收夹具仓库（票 08）。
# 用法: ./scripts/gen-perf-repo.sh <目标目录> [提交数，默认 100000]
# 用 git fast-import 生成：单主干线性 + 一条特性分支（200 提交）+ 一次合并。
set -euo pipefail

TARGET="${1:?用法: gen-perf-repo.sh <目标目录> [提交数]}"
COUNT="${2:-100000}"

mkdir -p "$TARGET"
git -C "$TARGET" init -q -b main
git -C "$TARGET" config user.email perf@fumigit.dev
git -C "$TARGET" config user.name "Fumi Perf"

{
  # 预置 3 个 blob 轮换使用
  for i in 1 2 3; do
    echo "blob"
    echo "mark :$i"
    echo "data 16"
    echo "content v$i pad"
  done

  ts=1600000000
  mark=10
  main_tip=""
  feat_tip=""

  emit_commit() { # <branch> <msg>
    ts=$(( ts + 60 ))
    echo "commit $1"
    echo "mark :$mark"
    echo "author Fumi Perf <perf@fumigit.dev> $ts +0000"
    echo "committer Fumi Perf <perf@fumigit.dev> $ts +0000"
    echo "data ${#2}"
    echo "$2"
    echo "M 100644 :$(( mark % 3 + 1 )) a.txt"
    echo ""
  }

  feat_start=$(( COUNT / 3 ))
  feat_end=$(( feat_start + 200 ))

  for i in $(seq 1 "$COUNT"); do
    if [ "$i" -eq "$feat_start" ]; then
      echo "reset refs/heads/feat"
      echo "from :$main_tip"
      echo ""
    fi
    if [ "$i" -gt "$feat_start" ] && [ "$i" -le "$feat_end" ]; then
      emit_commit "refs/heads/feat" "feat commit $i"
      feat_tip=":$mark"
    else
      emit_commit "refs/heads/main" "main commit $i"
      main_tip=":$mark"
    fi
    mark=$(( mark + 1 ))
    if [ "$i" -eq "$feat_end" ]; then
      ts=$(( ts + 60 ))
      echo "commit refs/heads/main"
      echo "mark :$mark"
      echo "author Fumi Perf <perf@fumigit.dev> $ts +0000"
      echo "committer Fumi Perf <perf@fumigit.dev> $ts +0000"
      echo "data 11"
      echo "Merge feat"
      echo "from $main_tip"
      echo "merge $feat_tip"
      echo "M 100644 :1 a.txt"
      echo ""
      main_tip=":$mark"
      mark=$(( mark + 1 ))
    fi
  done
} | git -C "$TARGET" fast-import --quiet

echo "完成：$TARGET （$COUNT 提交 + feat 分支 + 合并）"
