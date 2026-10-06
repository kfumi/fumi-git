// 应用骨架：未开仓库 → 欢迎页；已开 → 三栏工作台（定稿布局 ui-spec）
import { useEffect } from "react";
import { listenRepoChanged } from "./lib/ipc";
import { useRepo } from "./stores/repo";
import { useTheme } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { GraphList } from "./components/GraphList";
import { CommitDetailPanel, StagePanel } from "./components/StagePanel";
import { Welcome } from "./components/Welcome";

export default function App() {
  const meta = useRepo((s) => s.meta);
  const hydrate = useRepo((s) => s.hydrate);
  const refresh = useRepo((s) => s.refresh);
  const setThemeFromConfig = useTheme((s) => s.hydrate);

  useEffect(() => {
    void hydrate().then(() => {
      const cfg = useRepo.getState().config;
      if (cfg) setThemeFromConfig(cfg.theme);
    });
    const un = listenRepoChanged(() => void refresh());
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!meta) return <Welcome />;

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <Toolbar />
      <div className="grid min-h-0 flex-1 grid-cols-[216px_1fr_396px]">
        <Sidebar />
        <GraphList />
        <div className="flex min-h-0 flex-col border-l border-brd bg-panel">
          <CommitDetailPanel />
          <StagePanel />
        </div>
      </div>
    </div>
  );
}
