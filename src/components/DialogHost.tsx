// 通用对话框宿主（ui-spec §4）：渲染 store 的 dialog 槽位。
// 确认 / 多选去向（脏树拦截）/ 输入表单统一走这一个组件；Escape = 取消，Enter = 首个主/危险动作。
import { useEffect, useRef, useState } from "react";
import { useRepo } from "../stores/repo";
import type { DialogDesc } from "../stores/repo";

export function DialogHost() {
  const desc = useRepo((s) => s.dialog);
  const closeDialog = useRepo((s) => s.closeDialog);
  if (!desc) return null;
  return <DialogPanel key={desc.title + desc.actions.length} desc={desc} onClose={closeDialog} />;
}

function DialogPanel({ desc, onClose }: { desc: DialogDesc; onClose: () => void }) {
  const [input, setInput] = useState(desc.input?.initial ?? "");
  const [checked, setChecked] = useState(desc.checkbox?.initial ?? false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const primary = desc.actions.find((a) => a.kind === "primary");

  // 输入即时校验（表单场景）；submit 错误单独展示，二者取先
  const [inputError, setInputError] = useState<string | null>(
    desc.input?.validate?.(desc.input?.initial ?? "") ?? null,
  );
  const error = inputError ?? submitError;

  useEffect(() => {
    if (desc.input) inputRef.current?.select();
  }, [desc.input]);

  const run = async (action: DialogDesc["actions"][number]) => {
    if (busy || inputError) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const r = await action.run(input, checked);
      if (r === false) return;
      if (typeof r === "string") {
        setSubmitError(r);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter" && primary && !(e.target instanceof HTMLTextAreaElement)) {
        // Enter 只绑定主动作，不绑定危险动作（多选/危险确认需显式点击）
        e.preventDefault();
        void run(primary);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desc, input, checked, busy, inputError]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(0,0,0,0.45)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[70vh] w-[380px] overflow-y-auto rounded-[10px] border border-brd bg-panel p-4 shadow-card">
        <h3 className="text-[13px] font-semibold text-ink">{desc.title}</h3>
        {desc.message && (
          <p className="mt-2 text-xs leading-relaxed text-dim">{desc.message}</p>
        )}
        {desc.files && desc.files.length > 0 && (
          <div className="mt-2 max-h-[40vh] overflow-y-auto rounded-lg border border-brd-soft bg-panel2 p-2">
            {desc.files.map((f) => (
              <div key={f} className="truncate py-0.5 font-mono text-[11.5px] text-dim">
                {f}
              </div>
            ))}
          </div>
        )}
        {desc.input && (
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSubmitError(null);
              setInputError(desc.input?.validate?.(e.target.value) ?? null);
            }}
            placeholder={desc.input.placeholder}
            className="mt-2.5 h-8 w-full rounded-lg border border-brd bg-panel2 px-2.5 text-xs text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
        )}
        {desc.checkbox && (
          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-dim">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            {desc.checkbox.label}
          </label>
        )}
        {error && (
          <p className="mt-2 rounded-md bg-bad-soft px-2 py-1.5 text-xs text-bad">{error}</p>
        )}
        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2">
          {desc.actions.map((a, i) => (
            <button
              key={i}
              disabled={busy}
              onClick={() => void run(a)}
              className={
                "whitespace-nowrap " +
                (a.kind === "primary"
                  ? "btn-primary"
                  : a.kind === "danger"
                    ? "btn-danger"
                    : "btn-ghost") +
                (busy ? " pointer-events-none opacity-60" : "")
              }
            >
              {a.label}
            </button>
          ))}
          {desc.cancelLabel !== null && (
            <button className="btn-ghost whitespace-nowrap" disabled={busy} onClick={onClose}>
              {desc.cancelLabel ?? "取消"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
