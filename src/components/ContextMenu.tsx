// 右键菜单基元（ui-spec §4）：受控组件，调用方持 {x, y, items} 状态。
// 点击外部 / Escape / 滚动 / 窗口失焦自动关闭；出现位置避让视口边缘。
// 2026-10-24 增补：header 分组行、active 行 ✓ 标记、行 title、面板内滚动（内部滚动不再误关闭）、可选 width。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

export type MenuItem = MenuAction | MenuSeparator | MenuHeader;

export interface MenuAction {
  kind?: "item";
  label: string;
  /** 右侧灰字提示（如快捷键 / 说明） */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** 当前行标记：左侧 ✓ + 文字加重（分支下拉的「当前分支」） */
  active?: boolean;
  /** 悬停 tooltip（分支行：完整名 → 短 hash） */
  title?: string;
  /** 行内右键（分支下拉对单个分支呼出操作菜单）；面板自身随之关闭 */
  onContextMenu?: (x: number, y: number) => void;
  onSelect?: () => void;
}

/** 分组分隔线：把「移动引用 / 派生改动 / 破坏性」几类动作隔开 */
export interface MenuSeparator {
  kind: "separator";
}

/** 分组标题行：不可交互的小节标签（如「本地分支 / 远程分支」） */
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
  width,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** 固定宽度（分支下拉等长列表用）；缺省自适应 min-w-[150px] */
  width?: number;
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
    const onScroll = (e: Event) => {
      // 面板自身滚动（分支下拉等长列表）不关闭；页面滚动 / 容器内滚动仍关闭
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
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

  // 任一行带 active 标记时，所有行保留 ✓ 槽位对齐；纯动作菜单不受影响
  const showCheck = items.some((it) => !isSeparator(it) && !isHeader(it) && it.active);
  // 被视口下缘顶上去（向上翻转）→ 缩放锚点换到底边，进场动画从底部展开
  const origin = pos.y < y ? "bottom left" : "top left";

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y, transformOrigin: origin, ...(width ? { width } : {}) }}
      onContextMenu={(e) => e.preventDefault()}
      className="menu-in fixed z-50 max-h-[70vh] min-w-[150px] overflow-y-auto rounded-lg border border-brd bg-panel py-1 shadow-card"
    >
      {items.map((item, i) =>
        isSeparator(item) ? (
          <div
            key={i}
            role="separator"
            className="mx-2.5 my-1 h-px bg-brd-soft"
          />
        ) : isHeader(item) ? (
          <div key={i} role="presentation" className="section-label px-2.5 pb-0.5 pt-1.5">
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
            {showCheck &&
              (item.active ? (
                <Check size={12} className="shrink-0 text-accent" aria-hidden />
              ) : (
                <span className="w-3 shrink-0" aria-hidden />
              ))}
            <span className={item.active ? "truncate font-medium text-ink" : "truncate"}>
              {item.label}
            </span>
            {item.hint && <span className="ml-auto pl-3 text-[0.65625rem]">{item.hint}</span>}
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
            onContextMenu={(e) => item.onContextMenu?.(e.clientX, e.clientY)}
            className={
              "flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs transition-colors " +
              (item.danger
                ? "text-bad hover:bg-[rgba(242,112,138,0.10)]"
                : "text-dim hover:bg-hover hover:text-ink")
            }
          >
            {showCheck &&
              (item.active ? (
                <Check size={12} className="shrink-0 text-accent" aria-hidden />
              ) : (
                <span className="w-3 shrink-0" aria-hidden />
              ))}
            <span className={item.active ? "truncate font-medium text-ink" : "truncate"}>
              {item.label}
            </span>
            {item.hint && (
              <span className="ml-auto shrink-0 pl-3 text-[0.65625rem] text-faint">{item.hint}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
