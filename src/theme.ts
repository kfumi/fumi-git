import { create } from "zustand";

export type ThemeMode = "dark" | "light" | "system";

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
  setMode: (mode: ThemeMode) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  mode: "system",
  setMode: (mode) => {
    applyMode(mode);
    set({ mode });
  },
}));
