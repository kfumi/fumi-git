import { create } from "zustand";
import { ipc } from "./lib/ipc";
import type { ThemeMode } from "./lib/types";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export const resolveMode = (mode: ThemeMode): "dark" | "light" =>
  mode === "system" ? (media.matches ? "dark" : "light") : mode;

export const applyMode = (mode: ThemeMode) => {
  document.documentElement.dataset.mode = resolveMode(mode);
};

media.addEventListener("change", () => {
  if (useTheme.getState().mode === "system") applyMode("system");
});

interface ThemeState {
  mode: ThemeMode;
  /** 启动时从后端配置恢复（票 01：主题选择跨重启保留） */
  hydrate: (saved: ThemeMode) => void;
  setMode: (mode: ThemeMode) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  mode: "system",
  hydrate: (saved) => {
    applyMode(saved);
    set({ mode: saved });
  },
  setMode: (mode) => {
    applyMode(mode);
    set({ mode });
    // 持久化失败不阻塞 UI（如 dev 浏览器无后端）
    void ipc.setTheme(mode).catch(() => {});
  },
}));

export const THEME_LABELS: Record<ThemeMode, string> = {
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
};
