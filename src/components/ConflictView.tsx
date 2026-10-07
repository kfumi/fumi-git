// 冲突解决视图（二阶段票 02/03）：三方对比 + 文件级选边 + 冲突块逐块取舍
// 点改动 tab 冲突组的文件行时整体替换右栏（优先级高于 stash/工作区 diff）
import { ArrowLeftRight, FileEdit, Check } from "lucide-react";
import { useRepo } from "../stores/repo";
import { parseConflictBlocks } from "../lib/conflict";

function VersionPane({ title, content }: { title: string; content: string | null }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-brd-soft bg-panel2">
      <div className="shrink-0 border-b border-brd-soft px-2.5 py-1.5 text-[10.5px] font-medium text-faint">
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {content ? (
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-dim">
            {content}
          </pre>
        ) : (
          <p className="text-[11px] text-faint">（该侧不存在此文件）</p>
        )}
      </div>
    </div>
  );
}

export function ConflictView() {
  const cv = useRepo((s) => s.conflictView);
  const resolveTakeFlow = useRepo((s) => s.resolveTakeFlow);
  const markResolvedFlow = useRepo((s) => s.markResolvedFlow);
  const openConflictInEditor = useRepo((s) => s.openConflictInEditor);
  if (!cv) return null;

  // 逐块取舍（票 03）：解析工作区结果中的冲突标记
  const parsed = cv.result ? parseConflictBlocks(cv.result) : null;
  const blocks = parsed?.wellFormed ? parsed.blocks : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-brd px-3">
        <span className="rounded bg-bad/15 px-1.5 py-0.5 text-[10px] font-medium text-bad">
          冲突
        </span>
        <span className="truncate font-mono text-[11px]" title={cv.path}>
          {cv.path}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            className="btn-ghost !h-6 !px-2 text-[10.5px]"
            title="整个文件采用我方版本并标记已解决"
            onClick={() => void resolveTakeFlow(cv.path, true)}
          >
            <ArrowLeftRight size={11} aria-hidden />
            采用我方
          </button>
          <button
            className="btn-ghost !h-6 !px-2 text-[10.5px]"
            title="整个文件采用对方版本并标记已解决"
            onClick={() => void resolveTakeFlow(cv.path, false)}
          >
            <ArrowLeftRight size={11} aria-hidden className="rotate-180" />
            采用对方
          </button>
          <button
            className="btn-ghost !h-6 !px-2 text-[10.5px]"
            title="在系统默认应用中打开，手动编辑后回来标记已解决"
            onClick={() => void openConflictInEditor(cv.path)}
          >
            <FileEdit size={11} aria-hidden />
            编辑器打开
          </button>
          <button
            className="btn-primary !h-6 !px-2 text-[10.5px]"
            title="把该文件加入暂存区，标记冲突已解决"
            onClick={() => void markResolvedFlow(cv.path)}
          >
            <Check size={11} aria-hidden />
            标记已解决
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {cv.loading ? (
          <p className="text-xs text-faint">加载三方内容…</p>
        ) : (
          <>
            <div className="grid shrink-0 grid-cols-2 gap-2" style={{ maxHeight: "40%" }}>
              <VersionPane title="我方（当前分支 :2）" content={cv.versions?.ours ?? null} />
              <VersionPane title="对方（传入 :3）" content={cv.versions?.theirs ?? null} />
            </div>
            {cv.versions?.base != null && (
              <details className="shrink-0 rounded-lg border border-brd-soft bg-panel2">
                <summary className="cursor-pointer px-2.5 py-1.5 text-[10.5px] font-medium text-faint">
                  共同祖先（:1）参考
                </summary>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-relaxed text-faint">
                  {cv.versions.base}
                </pre>
              </details>
            )}
            <div className="shrink-0 text-[10.5px] text-faint">
              工作区结果中的冲突块（{blocks.length} 个）——逐块取舍或到编辑器手动修改：
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              {blocks.length === 0 ? (
                <p className="text-[11px] text-faint">
                  {cv.result ? "没有冲突标记，可直接标记已解决。" : "无法读取工作区内容。"}
                </p>
              ) : (
                blocks.map((b, i) => (
                  <ConflictBlockRow key={i} index={i} block={b} />
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ConflictBlockRow({
  index,
  block,
}: {
  index: number;
  block: { oursLines: string[]; theirsLines: string[] };
}) {
  const path = useRepo((s) => s.conflictView?.path);
  const applyBlock = useRepo((s) => s.applyConflictBlock);
  return (
    <div className="overflow-hidden rounded-lg border border-brd-soft">
      <div className="flex items-center gap-1.5 border-b border-brd-soft bg-panel2 px-2.5 py-1.5">
        <span className="text-[10.5px] font-medium text-faint">冲突块 {index + 1}</span>
        <button
          className="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-accent-ink transition-colors hover:bg-hover"
          title="这一块采用我方内容"
          onClick={() => path && applyBlock(path, index, "ours")}
        >
          采用我方
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-[10.5px] text-accent-ink transition-colors hover:bg-hover"
          title="这一块采用对方内容"
          onClick={() => path && applyBlock(path, index, "theirs")}
        >
          采用对方
        </button>
      </div>
      <div className="grid grid-cols-2 divide-x divide-brd-soft">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-relaxed text-del">
          {block.oursLines.join("\n")}
        </pre>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-relaxed text-add">
          {block.theirsLines.join("\n")}
        </pre>
      </div>
    </div>
  );
}

