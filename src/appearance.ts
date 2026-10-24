// 外观（字体 / 字号 / 缩放）：与 theme.ts 同构 —— zustand 状态 + 后端 AppConfig 持久化。
// 生效机制：
// - 字体：html[data-ui-font]/[data-mono-font] 钩子 + index.css 逐预设手写规则。
//   不能改 CSS 变量：@theme inline 把字体栈编译期展开进 font-mono 类，运行时改变量无效。
// - 字号：html font-size = 16px × 比例。全部字号已 rem 化且 --spacing 冻结为 4px，
//   因此只有文字随比例缩放，间距 / 尺寸 / 行高(px) 都不动。
// - 缩放：优先 webview setZoom（原生页面缩放，Canvas 图谱重栅格化保持锐利），
//   调用失败（纯浏览器 dev / 权限缺失）退回 CSS zoom。
import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ipc } from "./lib/ipc";
import type { AppConfig } from "./lib/types";

export interface FontPreset {
  /** 存进 AppConfig 的键；null = 默认栈（键与 index.css 的 data 规则一一对应） */
  key: string | null;
  label: string;
}

export const UI_FONT_PRESETS: FontPreset[] = [
  { key: null, label: "默认（IBM Plex Sans）" },
  { key: "system-ui", label: "system-ui" },
  { key: "segoe", label: "Segoe UI" },
  { key: "yahei", label: "微软雅黑" },
  { key: "pingfang", label: "苹方" },
  { key: "sourcehan", label: "思源黑体 / Noto Sans CJK" },
];

export const MONO_FONT_PRESETS: FontPreset[] = [
  { key: null, label: "默认（IBM Plex Mono）" },
  { key: "cascadia", label: "Cascadia Code" },
  { key: "consolas", label: "Consolas" },
  { key: "jetbrains", label: "JetBrains Mono" },
];

/** 字号 / 缩放的范围与步进（设置对话框与快捷键共用） */
export const FONT_SCALE = { min: 0.85, max: 1.3, step: 0.05, default: 1 } as const;
export const ZOOM = { min: 0.6, max: 1.8, step: 0.1, default: 1 } as const;

interface Range {
  min: number;
  max: number;
  step: number;
}

/** 步进并夹取；按 step 的小数位数四舍五入，避免浮点误差累积（1.1+0.1≠1.2） */
export function stepValue(cur: number, dir: 1 | -1, spec: Range): number {
  const decimals = (String(spec.step).split(".")[1] ?? "").length;
  const next = Math.min(spec.max, Math.max(spec.min, cur + dir * spec.step));
  return Number(next.toFixed(decimals));
}

const ROOT_FONT_BASE = 16;

const applyFontScale = (scale: number) => {
  document.documentElement.style.fontSize = `${(ROOT_FONT_BASE * scale).toFixed(2)}px`;
};

const applyZoom = (zoom: number) => {
  const fallback = () => {
    document.documentElement.style.zoom = String(zoom);
  };
  try {
    void getCurrentWebview().setZoom(zoom).catch(fallback);
  } catch {
    fallback();
  }
};

const applyFonts = (ui: string | null, mono: string | null) => {
  const el = document.documentElement;
  if (ui) el.dataset.uiFont = ui;
  else delete el.dataset.uiFont;
  if (mono) el.dataset.monoFont = mono;
  else delete el.dataset.monoFont;
};

interface AppearanceState {
  uiFont: string | null;
  monoFont: string | null;
  fontScale: number;
  zoom: number;
  /** 设置对话框开合（工具栏齿轮触发） */
  settingsOpen: boolean;
  hydrate: (cfg: AppConfig) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setUiFont: (key: string | null) => void;
  setMonoFont: (key: string | null) => void;
  bumpFontScale: (dir: 1 | -1) => void;
  resetFontScale: () => void;
  bumpZoom: (dir: 1 | -1) => void;
  resetZoom: () => void;
}

type PersistShape = Pick<
  AppearanceState,
  "uiFont" | "monoFont" | "fontScale" | "zoom"
>;

const persist = (s: PersistShape) => {
  void ipc
    .setAppearance({ uiFont: s.uiFont, monoFont: s.monoFont, fontScale: s.fontScale, zoom: s.zoom })
    .catch(() => {
      // 持久化失败不阻塞 UI（如纯浏览器 dev 无后端）
    });
};

export const useAppearance = create<AppearanceState>((set, get) => ({
  uiFont: null,
  monoFont: null,
  fontScale: FONT_SCALE.default,
  zoom: ZOOM.default,
  settingsOpen: false,

  hydrate: (cfg) => {
    applyFonts(cfg.ui_font, cfg.mono_font);
    applyFontScale(cfg.font_scale);
    applyZoom(cfg.zoom);
    set({
      uiFont: cfg.ui_font,
      monoFont: cfg.mono_font,
      fontScale: cfg.font_scale,
      zoom: cfg.zoom,
    });
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  setUiFont: (key) => {
    const next = { ...get(), uiFont: key };
    applyFonts(next.uiFont, next.monoFont);
    set({ uiFont: key });
    persist(next);
  },
  setMonoFont: (key) => {
    const next = { ...get(), monoFont: key };
    applyFonts(next.uiFont, next.monoFont);
    set({ monoFont: key });
    persist(next);
  },

  bumpFontScale: (dir) => {
    const fontScale = stepValue(get().fontScale, dir, FONT_SCALE);
    applyFontScale(fontScale);
    set({ fontScale });
    persist({ ...get(), fontScale });
  },
  resetFontScale: () => {
    applyFontScale(FONT_SCALE.default);
    set({ fontScale: FONT_SCALE.default });
    persist({ ...get(), fontScale: FONT_SCALE.default });
  },

  bumpZoom: (dir) => {
    const zoom = stepValue(get().zoom, dir, ZOOM);
    applyZoom(zoom);
    set({ zoom });
    persist({ ...get(), zoom });
  },
  resetZoom: () => {
    applyZoom(ZOOM.default);
    set({ zoom: ZOOM.default });
    persist({ ...get(), zoom: ZOOM.default });
  },
}));
