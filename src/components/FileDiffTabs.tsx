// 右下：提交详情文件 diff —— 点击右上文件列表打开/切换，多 tab 可关闭
import { X } from "lucide-react";
import { useRepo } from "../stores/repo";
import { DetailDiff } from "./DiffView";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function FileDiffTabs() {
  const detail = useRepo((s) => s.detail);
  const loading = useRepo((s) => s.detailLoading);
  const openFiles = useRepo((s) => s.openFiles);
  const active = useRepo((s) => s.detailFile);
  const openDetailFile = useRepo((s) => s.openDetailFile);
  const closeDetailFile = useRepo((s) => s.closeDetailFile);

  if (!detail)
    return (
      <div className="flex h-full items-center justify-center bg-panel text-xs text-faint">
        在左侧选择一个提交后，点击上方文件查看 diff
      </div>
    );

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
