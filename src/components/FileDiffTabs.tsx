// 右下（历史 tab）：提交详情文件 diff —— 点击右上文件列表打开/切换，多 tab 可关闭
// 右栏（改动 tab）：工作区单文件 diff 面板，选中工作区文件时才出现
import { X } from "lucide-react";
import { useRepo } from "../stores/repo";
import { DiffView, DetailDiff } from "./DiffView";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function FileDiffTabs() {
  const detail = useRepo((s) => s.detail);
  const loading = useRepo((s) => s.detailLoading);
  const openFiles = useRepo((s) => s.openFiles);
  const active = useRepo((s) => s.detailFile);
  const openDetailFile = useRepo((s) => s.openDetailFile);
  const closeDetailFile = useRepo((s) => s.closeDetailFile);

  // 父层只在 openFiles 非空时挂载本组件；detail 缺失（理论不可达）时安静退场
  if (!detail) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-brd">
        {openFiles.map((path) => (
          <div
            key={path}
            className={
              "flex shrink-0 items-center border-r border-brd-soft pl-2.5 pr-1 text-[11px] " +
              (path === active
                ? "bg-panel2 text-ink shadow-[inset_0_2px_0_var(--accent)]"
                : "text-faint hover:text-dim")
            }
          >
            <button
              onClick={() => openDetailFile(path)}
              className="max-w-[150px] truncate font-mono"
              title={path}
            >
              {baseName(path)}
            </button>
            <button
              onClick={() => closeDetailFile(path)}
              className="ml-0.5 rounded p-0.5 transition-colors hover:bg-hover hover:text-ink"
              aria-label={`关闭 ${path}`}
              title="关闭"
            >
              <X size={10} aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <p className="text-xs text-faint">加载 diff…</p>
        ) : active && detail.files.some((f) => f.path === active) ? (
          <DetailDiff detail={detail} selectedFile={active} />
        ) : (
          <p className="text-xs text-faint">点击上方文件查看 diff</p>
        )}
      </div>
    </div>
  );
}

// 改动 tab 下右栏整体：选中工作区文件时的单文件 diff（父层保证 workFile 非空）
export function WorkDiffView() {
  const workFile = useRepo((s) => s.workFile);
  const workStaged = useRepo((s) => s.workStaged);
  const workDiff = useRepo((s) => s.workDiff);
  const loading = useRepo((s) => s.workDiffLoading);
  if (!workFile) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-brd px-3">
        <span
          className={
            "rounded px-1.5 py-0.5 text-[10px] font-medium " +
            (workStaged ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn")
          }
        >
          {workStaged ? "已暂存" : "未暂存"}
        </span>
        <span className="truncate font-mono text-[11px]" title={workFile}>
          {workFile}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <p className="text-xs text-faint">加载 diff…</p>
        ) : workDiff ? (
          <DiffView patch={workDiff} />
        ) : (
          <p className="text-xs text-faint">无文本变更（可能是二进制文件）</p>
        )}
      </div>
    </div>
  );
}
