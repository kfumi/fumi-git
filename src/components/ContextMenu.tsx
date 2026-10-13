// 菜单基元（ui-spec §4）：受控组件，调用方持 {x, y, items} 状态。
// 三份右键菜单与图谱筛选下拉（§1）共用：checked 勾选项 / kind:"header" 分组标题 /
// footer 底部扩展槽（筛选下拉的输入框）/ maxListH 长列表内滚 / anchor 锚点。
// 点击外部 / Escape / 窗口失焦自动关闭；出现位置避让视口边缘。
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = MenuAction | MenuSeparator | MenuHeader;

export interface MenuAction {
  kind?: "item";
  label: string;
  /** 右侧灰字提示（快捷键 / 说明 / 提交数等） */
  hint?: string;
  /** 勾选态（筛选下拉用）；只有列表里出现过 checked 才占左侧勾选位 */
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** 悬停说明（如提交者行的邮箱） */
  title?: string;
  onSelect?: () => void;
}

/** 分组分隔线：把「移动引用 / 派生改动 / 破坏性」几类动作隔开 */
export interface MenuSeparator {
  kind: "separator";
}

/** 分组标题（筛选下拉用）：不可点，点它也不关菜单 */
export interface MenuHeader {
  kind: "header";
  label: string;
}

function isSeparator(item: MenuItem): item is MenuSeparator {
  return item.kind === "separator";
}

function isHeader(item: MenuItem): item is MenuHeader {
  return item.kind === "header";
}

const MARGIN = 6;

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  footer,
  maxListH,
  anchor,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** 面板底部扩展槽（筛选下拉的输入框走这里） */
  footer?: React.ReactNode;
  /** 列表区最大高度（px）：超出内滚，分支多时下拉不越出视口 */
  maxListH?: number;
  /** 锚点元素：它上面的按下不算「点击外部」，按钮才能做正常的开/关 toggle */
  anchor?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // 只有列表里出现过 checked 才给勾选位，右键菜单的排版不受影响
  const hasCheck = items.some(
    (i) => !isSeparator(i) && !isHeader(i) && i.checked !== undefined,
  );

  // 首帧按实际尺寸避让视口边缘
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(MARGIN, Math.min(x, window.innerWidth - r.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(y, window.innerHeight - r.height - MARGIN)),
    });
  }, [x, y]);

  useEffect(() => {
    // 面板内（或锚点上）的事件不算「外部」；window/document 之类的非 Node 事件源一律算外部
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (!!ref.current?.contains(t) || !!anchor?.current?.contains(t));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 只有面板**外**的滚动才关闭：长列表内滚不该把菜单滚没了
    const onScroll = (e: Event) => {
      if (!inside(e.target)) onClose();
    };
    // 捕获阶段监听：容器内滚动也能关闭
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, anchor]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[150px] rounded-lg border border-brd bg-panel py-1 shadow-card"
    >
      <div style={maxListH ? { maxHeight: maxListH, overflowY: "auto" } : undefined}>
        {items.map((item, i) =>
          isSeparator(item) ? (
            <div key={i} role="separator" className="mx-2.5 my-1 h-px bg-brd-soft" />
          ) : isHeader(item) ? (
            <div key={i} className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-faint">
              {item.label}
            </div>
          ) : item.disabled ? (
            <button
              key={i}
              disabled
              role="menuitem"
              title={item.title}
              className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs text-dim opacity-45"
            >
              {hasCheck && <span className="w-3.5 shrink-0" />}
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="ml-auto pl-3 text-[10.5px]">{item.hint}</span>}
            </button>
          ) : (
            <button
              key={i}
              role="menuitem"
              title={item.title}
              onClick={() => {
                onClose();
                item.onSelect?.();
              }}
              className={
                "flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs transition-colors " +
                (item.danger
                  ? "text-bad hover:bg-[rgba(242,112,138,0.10)]"
                  : "text-dim hover:bg-hover hover:text-ink")
              }
            >
              {hasCheck && (
                <span className="w-3.5 shrink-0 text-accent-ink">{item.checked ? "✓" : ""}</span>
              )}
              <span className="truncate">{item.label}</span>
              {item.hint && (
                <span className="ml-auto shrink-0 pl-3 text-[10.5px] text-faint">{item.hint}</span>
              )}
            </button>
          ),
        )}
      </div>
      {footer && <div className="mt-1 border-t border-brd-soft px-2.5 py-1.5">{footer}</div>}
    </div>
  );
}
