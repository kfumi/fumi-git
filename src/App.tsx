// 应用骨架：未开仓库 → 欢迎页；已开 → 三栏工作台
// 栏宽可拖拽（react-resizable-panels），比例持久化到 localStorage（autoSaveId）
import { useEffect } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { listenRepoChanged } from "./lib/ipc";
import { useRepo } from "./stores/repo";
import { useTheme } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { MainArea } from "./components/MainArea";
import { CommitDetailPanel } from "./components/StagePanel";
import { FileDiffTabs, WorkDiffView } from "./components/FileDiffTabs";
import { HDivider, VDivider } from "./components/ResizeHandle";
import { Welcome } from "./components/Welcome";
import { ToastHost } from "./components/ToastHost";

export default function App() {
  const meta = useRepo((s) => s.meta);
  const hydrate = useRepo((s) => s.hydrate);
  const refresh = useRepo((s) => s.refresh);
  const setThemeFromConfig = useTheme((s) => s.hydrate);
  // 右栏按需出现：改动 tab 选中了工作区文件，或历史 tab 选中了提交
  const mainTab = useRepo((s) => s.mainTab);
  const workFile = useRepo((s) => s.workFile);
  const selectedId = useRepo((s) => s.selectedId);
  const showRight = mainTab === "changes" ? workFile !== null : selectedId !== null;

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
            <MainArea />
          </Panel>
          {showRight && <VDivider />}
          {showRight && (
            <Panel id="right" defaultSize={31} minSize={20} maxSize={44}>
              <RightPane />
            </Panel>
          )}
        </PanelGroup>
      </div>
      <ToastHost />
    </div>
  );
}

// 右栏跟随中栏 tab 与选中状态：
// 历史 → 提交详情常驻；点击详情文件后下半展开 diff tab 区（默认不占位）
// 改动 → 无详情面板；点击工作区文件后整栏展示其 diff
function RightPane() {
  const mainTab = useRepo((s) => s.mainTab);
  const openFiles = useRepo((s) => s.openFiles);
  const workFile = useRepo((s) => s.workFile);

  if (mainTab === "changes") {
    return workFile ? (
      <WorkDiffView />
    ) : (
      <div className="flex h-full items-center justify-center bg-panel text-xs text-faint">
        点击左侧文件查看改动 diff
      </div>
    );
  }
  if (openFiles.length === 0) return <CommitDetailPanel />;
  return (
    <PanelGroup direction="vertical" autoSaveId="fumigit-right">
      <Panel id="detail" defaultSize={55} minSize={20}>
        <CommitDetailPanel />
      </Panel>
      <HDivider />
      <Panel id="filediff" defaultSize={45} minSize={20}>
        <FileDiffTabs />
      </Panel>
    </PanelGroup>
  );
}
