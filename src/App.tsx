import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, type ThemeMode } from "./theme";

const MODES: { key: ThemeMode; label: string }[] = [
  { key: "dark", label: "深色" },
  { key: "light", label: "浅色" },
  { key: "system", label: "跟随系统" },
];

function App() {
  const { mode, setMode } = useTheme();
  const [name, setName] = useState("");
  const [greetMsg, setGreetMsg] = useState("");

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <main className="flex h-full flex-col items-center justify-center gap-8 bg-bg text-ink">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Fumi<span className="text-accent">Git</span>
        </h1>
        <p className="mt-2 text-dim">
          Tauri 2 · React 19 · Tailwind v4 · git CLI 后端 — 骨架就绪
        </p>
      </div>

      <div className="flex items-center gap-1 rounded-xl border border-brd bg-panel p-1">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={
              "rounded-lg px-3 py-1.5 text-xs transition-colors " +
              (mode === m.key
                ? "bg-accent-soft text-accent-ink"
                : "text-dim hover:text-ink")
            }
          >
            {m.label}
          </button>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="输入名字测试 Rust 桥接…"
          className="h-9 w-56 rounded-lg border border-brd bg-panel2 px-3 text-xs outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="h-9 rounded-lg bg-accent px-4 text-xs font-medium text-white hover:brightness-110"
        >
          调用 greet
        </button>
      </form>
      {greetMsg && <p className="font-mono text-xs text-ok">{greetMsg}</p>}
    </main>
  );
}

export default App;
