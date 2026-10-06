// 可拖拽分隔线：1px 视觉线 + 8px 命中区（v3 PanelResizeHandle，拖拽目标即本元素）
import { PanelResizeHandle } from "react-resizable-panels";

const LINE =
  "pointer-events-none absolute bg-brd transition-colors group-data-[resize-handle-state=hover]:bg-accent group-data-[resize-handle-state=drag]:bg-accent";

// 竖直分隔线（横向拖拽）
export function VDivider() {
  return (
    <PanelResizeHandle className="group relative w-2 cursor-col-resize outline-none transition-colors hover:bg-hover data-[resize-handle-state=drag]:bg-sel">
      <div className={LINE + " inset-y-0 left-1/2 w-px -translate-x-1/2"} />
    </PanelResizeHandle>
  );
}

// 水平分隔线（纵向拖拽）
export function HDivider() {
  return (
    <PanelResizeHandle className="group relative h-2 cursor-row-resize outline-none transition-colors hover:bg-hover data-[resize-handle-state=drag]:bg-sel">
      <div className={LINE + " inset-x-0 top-1/2 h-px -translate-y-1/2"} />
    </PanelResizeHandle>
  );
}
