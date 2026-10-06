// ref 徽章：HEAD / 本地分支 / 远程 / 标签 四种样式（定稿见 ui-spec）。
// 根节点 display:contents —— 徽章直接参与外层 flex-wrap，装不下时逐个换行。
import { Cloud, GitBranch, Tag } from "lucide-react";
import type { CommitEntry } from "../lib/types";
import { classifyRef } from "../lib/refs";

export function RefChips({ refs, max }: { refs: CommitEntry["refs"]; max?: number }) {
  if (!refs.length) return null;
  const overflow = max && refs.length > max ? refs.length - max : 0;
  const shown = overflow ? refs.slice(0, max) : refs;
  return (
    <span className="contents">
      {shown.map((r) => {
        switch (classifyRef(r)) {
          case "head":
            return (
              <span
                key={r}
                className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-[7px] py-px text-[10.5px] font-medium text-white"
              >
                HEAD
              </span>
            );
          case "remote":
            return (
              <span
                key={r}
                className="flex shrink-0 items-center gap-1 rounded-md border border-brd px-[6px] py-px text-[10.5px] text-dim"
                title="远程分支"
              >
                <Cloud size={9.5} aria-hidden className="text-faint" />
                {r}
              </span>
            );
          case "tag":
            return (
              <span
                key={r}
                className="flex shrink-0 items-center gap-1 rounded-md bg-warn/15 px-[6px] py-px text-[10.5px] text-warn"
              >
                <Tag size={9.5} aria-hidden />
                {r.slice(4)}
              </span>
            );
          default:
            return (
              <span
                key={r}
                className="flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-[6px] py-px text-[10.5px] font-medium text-accent-ink"
              >
                <GitBranch size={9.5} aria-hidden />
                {r}
              </span>
            );
        }
      })}
      {overflow > 0 && (
        <span
          className="flex shrink-0 items-center rounded-md border border-brd px-[6px] py-px text-[10.5px] text-faint"
          title={`其余 ${overflow} 个引用：${refs.slice(max).join("、")}`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
