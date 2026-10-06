// 应用骨架：未开仓库 → 欢迎页；已开 → 三栏工作台
// 栏宽可拖拽（react-resizable-panels），比例持久化到 localStorage（autoSaveId）
import { useEffect } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { listenRepoChanged } from "./lib/ipc";
import { useRepo } from "./stores/repo";
import { useTheme } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { GraphList } from "./components/GraphList";
import { CommitDetailPanel, StagePanel } from "./components/StagePanel";
import { HDivider, VDivider } from "./components/ResizeHandle";
import { Welcome } from "./components/Welcome";
import { ToastHost } from "./components/ToastHost";

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

  if (!meta)
    return (
      <>
        <ToastHost />
        <Welcome />
      </>
    );

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <Toolbar />
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="fumigit-cols">
          <Panel id="sidebar" defaultSize={17} minSize={12} maxSize={25}>
            <Sidebar />
          </Panel>
          <VDivider />
          <Panel id="graph" defaultSize={52} minSize={30}>
            <GraphList />
          </Panel>
          <VDivider />
          <Panel id="right" defaultSize={31} minSize={20} maxSize={44}>
            <PanelGroup direction="vertical" autoSaveId="fumigit-right">
              <Panel id="detail" defaultSize={57} minSize={16}>
                <CommitDetailPanel />
              </Panel>
              <HDivider />
              <Panel id="stage" defaultSize={43} minSize={20}>
                <StagePanel />
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
      <ToastHost />
    </div>
  );
}
