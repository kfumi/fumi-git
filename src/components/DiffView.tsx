// 统一 diff 渲染：行号 + 增删着色（票 04）
import { useMemo } from "react";
import type { CommitDetail } from "../lib/types";

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/** 解析 unified diff 文本；只保留每个文件的 @@ 块（文件头由 FileList 呈现）。 */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  // 文件头（--- / +++）只出现在 hunk 之前；进入 hunk 后的 --- 行是删除内容
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git") || raw.startsWith("index ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && (raw.startsWith("--- ") || raw.startsWith("+++ "))) {
      continue;
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      out.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw });
    } else if (raw.startsWith("\\")) {
      out.push({ kind: "meta", oldNo: null, newNo: null, text: raw });
    } else {
      out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw });
    }
  }
  return out;
}

const KIND_CLASS: Record<DiffLine["kind"], string> = {
  add: "bg-add-bg text-add",
  del: "bg-del-bg text-del",
  ctx: "",
  hunk: "bg-accent-soft text-accent-ink text-[10.5px]",
  meta: "text-faint italic",
};

export function DiffView({ patch }: { patch: string }) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  return (
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.65]">
      {lines.map((l, i) => (
        <div key={i} className={`flex whitespace-pre ${KIND_CLASS[l.kind]}`}>
          <span className="w-11 shrink-0 select-none pr-2.5 text-right text-[10.5px] text-faint opacity-65">
            {l.oldNo ?? ""}
          </span>
          <span className="w-11 shrink-0 select-none pr-2.5 text-right text-[10.5px] text-faint opacity-65">
            {l.newNo ?? ""}
          </span>
          <span className="pr-3">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

export function DetailDiff({
  detail,
  selectedFile,
}: {
  detail: CommitDetail;
  selectedFile: string | null;
}) {
  const filePatch = useMemo(() => {
    if (!detail.patch || !selectedFile) return null;
    // 从整段 patch 中截取该文件的段落：按各段头部 `+++ b/<path>` 精确匹配，避免前缀重名错配
    const marker = "diff --git";
    const sections = detail.patch.split(marker).filter((s) => s.trim());
    const hit = sections.find((s) => s.split("\n").some((l) => l === `+++ b/${selectedFile}`));
    return hit ? marker + hit : null;
  }, [detail.patch, selectedFile]);

  if (detail.patch === null) {
    return (
      <div className="rounded-lg border border-brd bg-panel2 p-3 text-xs text-faint">
        合并提交 — 无直接文件变更（父提交见上方）
      </div>
    );
  }
  if (!filePatch) return null;
  return <DiffView patch={filePatch} />;
}
