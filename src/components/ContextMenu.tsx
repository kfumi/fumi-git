// 右键菜单基元（ui-spec §4）：受控组件，调用方持 {x, y, items} 状态。
// 点击外部 / Escape / 滚动 / 窗口失焦自动关闭；出现位置避让视口边缘。
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = MenuAction | MenuSeparator;

export interface MenuAction {
  kind?: "item";
  label: string;
  /** 右侧灰字提示（如快捷键 / 说明） */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

/** 分组分隔线：把「移动引用 / 派生改动 / 破坏性」几类动作隔开 */
export interface MenuSeparator {
  kind: "separator";
}

function isSeparator(item: MenuItem): item is MenuSeparator {
  return item.kind === "separator";
}

const MARGIN = 6;

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

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
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    // 捕获阶段监听：容器内滚动也能关闭
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("blur", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("blur", onScroll);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[150px] rounded-lg border border-brd bg-panel py-1 shadow-card"
    >
      {items.map((item, i) =>
        isSeparator(item) ? (
          <div
            key={i}
            role="separator"
            className="mx-2.5 my-1 h-px bg-brd-soft"
          />
        ) : item.disabled ? (
          <button
            key={i}
            disabled
            role="menuitem"
            className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs text-dim opacity-45"
          >
            {item.label}
            {item.hint && <span className="ml-auto pl-3 text-[10.5px]">{item.hint}</span>}
          </button>
        ) : (
          <button
            key={i}
            role="menuitem"
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
            <span className="truncate">{item.label}</span>
            {item.hint && (
              <span className="ml-auto shrink-0 pl-3 text-[10.5px] text-faint">{item.hint}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
