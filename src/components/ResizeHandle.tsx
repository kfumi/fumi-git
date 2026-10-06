// 可拖拽分隔线：1px 视觉线 + 8px 命中区（v3 PanelResizeHandle，拖拽目标即本元素）
import { useRef } from "react";
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

// 侧栏宽度手柄（像素级，独立于 PanelGroup —— 右栏显隐不影响侧栏宽度）
export function SidebarHandle({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (w: number) => void;
}) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      className="group relative w-2 shrink-0 cursor-col-resize touch-none outline-none transition-colors hover:bg-hover"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startW: width };
      }}
      onPointerMove={(e) => {
        if (dragRef.current) onWidthChange(dragRef.current.startW + e.clientX - dragRef.current.startX);
      }}
      onPointerUp={(e) => {
        dragRef.current = null;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      }}
    >
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-brd transition-colors group-hover:bg-accent" />
    </div>
  );
}
