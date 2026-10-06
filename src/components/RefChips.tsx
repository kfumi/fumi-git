// ref 徽章：HEAD / 本地分支 / 远程 / 标签 四种样式（定稿见 ui-spec）
import type { CommitEntry } from "../lib/types";
import { classifyRef } from "../lib/refs";

export function RefChips({ refs }: { refs: CommitEntry["refs"] }) {
  if (!refs.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {refs.map((r) => {
        switch (classifyRef(r)) {
          case "head":
            return (
              <span key={r} className="rounded-md bg-accent px-[7px] py-px text-[10.5px] font-medium text-white">
                HEAD
              </span>
            );
          case "remote":
            return (
              <span
                key={r}
                className="rounded-md border border-brd px-[7px] py-px text-[10.5px] text-dim"
                title="远程分支"
              >
                ⇅ {r}
              </span>
            );
          case "tag":
            return (
              <span key={r} className="rounded-md bg-warn/15 px-[7px] py-px text-[10.5px] text-warn">
                ⚑ {r.slice(4)}
              </span>
            );
          default:
            return (
              <span key={r} className="rounded-md bg-accent-soft px-[7px] py-px text-[10.5px] font-medium text-accent-ink">
                {r}
              </span>
            );
        }
      })}
    </span>
  );
}
