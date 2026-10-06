// 浮动消息提示栈：成功 / 失败 / 进行中 三态，右下角常驻。
// busy 提示由 store 原地转场为结果，不重复弹条。
import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, LoaderCircle, X } from "lucide-react";
import { useRepo, type Toast } from "../stores/repo";

/** 自动消失时长；0 = 常驻（busy 由动作结束时就地改写或替换） */
const AUTO_DISMISS_MS: Record<Toast["kind"], number> = { ok: 4000, err: 8000, busy: 0 };

const ICON: Record<Toast["kind"], typeof CircleCheck> = {
  ok: CircleCheck,
  err: CircleX,
  busy: LoaderCircle,
};

const ICON_COLOR: Record<Toast["kind"], string> = {
  ok: "text-ok",
  err: "text-bad",
  busy: "text-dim animate-spin",
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useRepo((s) => s.dismissToast);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number>(0);
  const ms = AUTO_DISMISS_MS[toast.kind];

  const leave = () => {
    window.clearTimeout(timer.current);
    if (leaving) return;
    setLeaving(true);
    // 时长与 .toast-leave 动画一致
    window.setTimeout(() => dismiss(toast.id), 140);
  };

  useEffect(() => {
    if (!ms) return;
    timer.current = window.setTimeout(leave, ms);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, toast.id]);

  const pause = () => ms && window.clearTimeout(timer.current);
  const resume = () => ms && (timer.current = window.setTimeout(leave, ms));

  const Icon = ICON[toast.kind];
  return (
    <div
      role={toast.kind === "err" ? "alert" : "status"}
      onMouseEnter={pause}
      onMouseLeave={resume}
      title={toast.text}
      className={
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border border-brd bg-panel px-3 py-2.5 text-xs shadow-card " +
        (leaving ? "toast-leave" : "toast-enter")
      }
    >
      <Icon size={15} className={`mt-px shrink-0 ${ICON_COLOR[toast.kind]}`} aria-hidden />
      <span className="min-w-0 flex-1 break-words leading-relaxed text-ink line-clamp-3">
        {toast.text}
      </span>
      <button
        aria-label="关闭提示"
        onClick={leave}
        className="-m-1 shrink-0 rounded p-1 text-faint transition-colors hover:text-ink"
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useRepo((s) => s.toasts);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[340px] flex-col items-end gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
