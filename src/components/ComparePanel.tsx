// 右栏「比较」模式（工单 08 / ui-spec §4 增补）：HEAD ↔ 所选提交。
// 文件行复用提交详情的 FileRow、patch 复用 DiffView —— 不复制一份解析/着色实现。
import { useRepo } from "../stores/repo";
import { DiffView } from "./DiffView";
import { FileRow } from "./StagePanel";

export function ComparePanel() {
  const compare = useRepo((s) => s.compare);
  if (!compare) return null;
  const { base, head, data, loading } = compare;
  const title = data
    ? `HEAD (${data.base.short_id}) ↔ ${data.head.short_id} ${data.head.subject}`
    : `HEAD ↔ ${head.slice(0, 7)}`;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-panel p-4">
      <div className="mb-2.5 flex items-center gap-2 text-xs text-dim">
        <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent-ink">
          比较
        </span>
        <span className="truncate" title={title}>
          {loading ? title + " 加载中…" : title}
        </span>
      </div>
      {loading && <p className="text-xs text-faint">正在比较…</p>}
      {!loading && !data && <p className="text-xs text-faint">比较失败，请重试</p>}
      {!loading && data && (
        <>
          {data.files.length === 0 ? (
            <p className="rounded-lg border border-brd bg-panel2 p-3 text-xs text-faint">
              与 HEAD 无差异
            </p>
          ) : (
            <>
              <div className="mb-3 overflow-hidden rounded-lg border border-brd bg-panel2">
                {data.files.map((f) => (
                  <FileRow key={f.path + (f.old_path ?? "")} file={f} active={false} />
                ))}
              </div>
              {data.patch ? (
                <DiffView patch={data.patch} />
              ) : (
                <p className="text-xs text-faint">无文本差异（二进制或仅模式变更）</p>
              )}
            </>
          )}
          <p className="mt-3 text-[10.5px] text-faint">
            基准 {base} · {data.files.length} 个文件
          </p>
        </>
      )}
    </div>
  );
}
