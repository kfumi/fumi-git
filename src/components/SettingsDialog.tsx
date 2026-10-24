// 设置对话框（工具栏齿轮）：外观（主题）/ 字体 / 字号 / 缩放。
// 即时生效即时持久化，无保存按钮（与主题切换的行为一致）。
// 视觉沿用 ui-spec §4 模态基元；表单内容不走 DialogHost（那是确认动作流）。
import { useEffect } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { useTheme, THEME_LABELS } from "../theme";
import {
  useAppearance,
  UI_FONT_PRESETS,
  MONO_FONT_PRESETS,
  FONT_SCALE,
  ZOOM,
} from "../appearance";
import type { ThemeMode } from "../lib/types";

export function SettingsDialog() {
  const open = useAppearance((s) => s.settingsOpen);
  const close = useAppearance((s) => s.closeSettings);

  // Escape 关闭（捕获阶段，避免输入框焦点拦截）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(0,0,0,0.45)]"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-[420px] max-h-[70vh] overflow-y-auto rounded-[10px] border border-brd bg-panel shadow-card">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-brd-soft bg-panel px-5 py-3">
          <h3 className="text-[0.8125rem] font-semibold">设置</h3>
          <button
            onClick={close}
            aria-label="关闭设置"
            className="rounded-md p-1 text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <X size={13} aria-hidden />
          </button>
        </header>

        <ThemeSection />
        <FontSection />
        <ScaleSection />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="shrink-0 text-xs text-dim">{label}</span>
      {children}
    </div>
  );
}

function SectionTitle({ label }: { label: string }) {
  return <h4 className="section-label pb-1 pt-4">{label}</h4>;
}

function ThemeSection() {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);
  return (
    <section className="px-5 pb-1">
      <SectionTitle label="外观" />
      <div className="flex gap-1 rounded-lg border border-brd bg-panel2 p-1">
        {(Object.keys(THEME_LABELS) as ThemeMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={
              "h-6 flex-1 rounded-md text-xs transition-colors " +
              (mode === m
                ? "bg-accent-soft font-medium text-accent-ink shadow-[inset_0_0_0_1px_var(--accent)]"
                : "text-dim hover:text-ink")
            }
          >
            {THEME_LABELS[m]}
          </button>
        ))}
      </div>
    </section>
  );
}

function FontSection() {
  const uiFont = useAppearance((s) => s.uiFont);
  const monoFont = useAppearance((s) => s.monoFont);
  const setUiFont = useAppearance((s) => s.setUiFont);
  const setMonoFont = useAppearance((s) => s.setMonoFont);
  const selectCls =
    "h-7 min-w-0 flex-1 rounded-lg border border-brd bg-panel2 px-2 text-xs text-ink outline-none transition-colors focus:border-accent";
  return (
    <section className="px-5 pb-1">
      <SectionTitle label="字体" />
      <Row label="界面字体">
        <select
          value={uiFont ?? ""}
          onChange={(e) => setUiFont(e.target.value || null)}
          className={selectCls}
          aria-label="界面字体"
        >
          {UI_FONT_PRESETS.map((p) => (
            <option key={p.key ?? "default"} value={p.key ?? ""}>
              {p.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="等宽字体">
        <select
          value={monoFont ?? ""}
          onChange={(e) => setMonoFont(e.target.value || null)}
          className={selectCls}
          aria-label="等宽字体"
        >
          {MONO_FONT_PRESETS.map((p) => (
            <option key={p.key ?? "default"} value={p.key ?? ""}>
              {p.label}
            </option>
          ))}
        </select>
      </Row>
      {/* 预览：hash 用等宽、正文用界面字体，选中即换 */}
      <div className="mt-1 rounded-lg bg-panel2 px-3 py-2 text-xs text-dim">
        提交图谱是主角 <span className="font-mono text-accent-ink">5d16d09</span> AaBb 与国
      </div>
    </section>
  );
}

function Stepper({
  value,
  min,
  max,
  onBump,
  onReset,
  hint,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onBump: (dir: 1 | -1) => void;
  onReset: () => void;
  hint?: string;
  ariaLabel: string;
}) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="flex items-center gap-1">
      <button
        className="btn-ghost icon-btn"
        aria-label={`${ariaLabel}减小`}
        disabled={value <= min}
        onClick={() => onBump(-1)}
      >
        <Minus size={12} aria-hidden />
      </button>
      <span className="tnum w-11 text-center text-xs font-medium">{pct(value)}</span>
      <button
        className="btn-ghost icon-btn"
        aria-label={`${ariaLabel}增大`}
        disabled={value >= max}
        onClick={() => onBump(1)}
      >
        <Plus size={12} aria-hidden />
      </button>
      <button
        className="btn-ghost icon-btn"
        aria-label={`${ariaLabel}还原`}
        title="还原 100%"
        disabled={value === 1}
        onClick={onReset}
      >
        <RotateCcw size={12} aria-hidden />
      </button>
      {hint && <span className="pl-1 text-[0.65625rem] text-faint">{hint}</span>}
    </div>
  );
}

function ScaleSection() {
  const fontScale = useAppearance((s) => s.fontScale);
  const zoom = useAppearance((s) => s.zoom);
  const bumpFontScale = useAppearance((s) => s.bumpFontScale);
  const resetFontScale = useAppearance((s) => s.resetFontScale);
  const bumpZoom = useAppearance((s) => s.bumpZoom);
  const resetZoom = useAppearance((s) => s.resetZoom);
  return (
    <section className="px-5 pb-5">
      <SectionTitle label="大小" />
      <Row label="字号">
        <Stepper
          value={fontScale}
          min={FONT_SCALE.min}
          max={FONT_SCALE.max}
          onBump={bumpFontScale}
          onReset={resetFontScale}
          ariaLabel="字号"
          hint="只缩放文字"
        />
      </Row>
      <Row label="缩放">
        <Stepper
          value={zoom}
          min={ZOOM.min}
          max={ZOOM.max}
          onBump={bumpZoom}
          onReset={resetZoom}
          ariaLabel="缩放"
          hint="Ctrl+= / - / 0"
        />
      </Row>
    </section>
  );
}
