// 应用骨架：未开仓库 → 欢迎页；已开 → 侧栏 + 中栏工作台（右栏按需出现）
// 侧栏像素级宽度独立持久化（右栏显隐不影响其宽度）；中/右宽度由 react-resizable-panels 管理
// Panel 的 id + order 必须成对给：面板是条件渲染的（动态增删），只给 id 会被库警告
// （id 决定 autoSaveId 的持久化键，order 决定注册顺序，两者缺一都可能错位）
import { useEffect, useState } from "react";
import { X, FileDiff } from "lucide-react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { listenRepoChanged } from "./lib/ipc";
import { useRepo } from "./stores/repo";
import { useTheme } from "./theme";
import { useAppearance, ZOOM } from "./appearance";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { MainArea } from "./components/MainArea";
import { CommitDetailPanel } from "./components/StagePanel";
import { FileDiffTabs, StashDiffView, WorkDiffView } from "./components/FileDiffTabs";
import { ConflictView } from "./components/ConflictView";
import { ComparePanel } from "./components/ComparePanel";
import { HDivider, SidebarHandle, VDivider } from "./components/ResizeHandle";
import { Welcome } from "./components/Welcome";
import { ToastHost } from "./components/ToastHost";
import { DialogHost } from "./components/DialogHost";
import { SettingsDialog } from "./components/SettingsDialog";

const SIDEBAR_MIN = 140;
const SIDEBAR_MAX = 340;
const SIDEBAR_KEY = "fumigit.sidebar-width";

function loadSidebarWidth(): number {
  const w = Number(localStorage.getItem(SIDEBAR_KEY));
  return Number.isFinite(w) && w >= SIDEBAR_MIN && w <= SIDEBAR_MAX ? w : 216;
}

export default function App() {
  const meta = useRepo((s) => s.meta);
  const hydrate = useRepo((s) => s.hydrate);
  const refresh = useRepo((s) => s.refresh);
  const setThemeFromConfig = useTheme((s) => s.hydrate);
  // 右栏按需出现：改动 tab 选中了工作区文件，或历史 tab 选中了提交
  const mainTab = useRepo((s) => s.mainTab);
  const workFile = useRepo((s) => s.workFile);
  const selectedId = useRepo((s) => s.selectedId);
  const stashView = useRepo((s) => s.stashView);
  const conflictView = useRepo((s) => s.conflictView);
  const compare = useRepo((s) => s.compare);
  // 右栏按需出现：冲突解决视图、stash 条目查看、改动 tab 选中了工作区文件、或历史 tab 选中了提交
  const showRight =
    conflictView !== null ||
    stashView !== null ||
    compare !== null ||
    (mainTab === "changes" ? workFile !== null : selectedId !== null);
  const [sidebarW, setSidebarW] = useState(loadSidebarWidth);

  useEffect(() => {
    void hydrate().then(() => {
      const cfg = useRepo.getState().config;
      if (cfg) {
        setThemeFromConfig(cfg.theme);
        // 外观（字体/字号/缩放）与主题同批从后端配置恢复
        useAppearance.getState().hydrate(cfg);
      }
    });
    const un = listenRepoChanged(() => void refresh());
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 界面缩放快捷键（浏览器习惯）：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 还原。
  // 捕获阶段接管，防止 webview 默认行为；与 Ctrl+Enter 提交等现有快捷键无冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const zoom = useAppearance.getState();
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoom.bumpZoom(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoom.bumpZoom(-1);
      } else if (e.key === "0" && zoom.zoom !== ZOOM.default) {
        e.preventDefault();
        zoom.resetZoom();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!meta)
    return (
      <>
        <ToastHost />
        <Welcome />
      </>
    );
  const updateSidebarW = (w: number) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
    setSidebarW(clamped);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(clamped));
    } catch {
      // 存不进去只影响下次启动的宽度
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <div style={{ width: sidebarW }} className="h-full shrink-0">
          <Sidebar />
        </div>
        <SidebarHandle width={sidebarW} onWidthChange={updateSidebarW} />
        <div className="h-full min-w-0 flex-1">
          <PanelGroup direction="horizontal" autoSaveId="fumigit-main-cols">
            <Panel id="graph" order={1} defaultSize={63} minSize={30}>
              <MainArea />
            </Panel>
            {showRight && <VDivider />}
            {showRight && (
              <Panel id="right" order={2} defaultSize={37} minSize={24} maxSize={52}>
                <RightPane />
              </Panel>
            )}
          </PanelGroup>
        </div>
      </div>
      <ToastHost />
      <DialogHost />
      <SettingsDialog />
    </div>
  );
}

// 右栏跟随中栏 tab 与选中状态：
// 历史 → 提交详情常驻；点击详情文件后下半展开 diff tab 区（默认不占位）
// 改动 → 无详情面板；点击工作区文件后整栏展示其 diff
// 右上角关闭按钮 = 移除触发条件（改动：收起工作文件 diff；历史：取消选中提交）
function RightPane() {
  const mainTab = useRepo((s) => s.mainTab);
  const openFiles = useRepo((s) => s.openFiles);
  const workFile = useRepo((s) => s.workFile);
  const stashView = useRepo((s) => s.stashView);
  const conflictView = useRepo((s) => s.conflictView);
  const compare = useRepo((s) => s.compare);
  const closeRightPane = useRepo((s) => s.closeRightPane);

  let content: React.ReactNode;
  // 冲突解决视图优先，其次 stash 查看、比较模式
  if (conflictView) {
    content = <ConflictView />;
  } else if (stashView) {
    content = <StashDiffView />;
  } else if (compare) {
    content = <ComparePanel />;
  } else if (mainTab === "changes") {
    content = workFile ? (
      <WorkDiffView />
    ) : (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-panel text-faint">
        <FileDiff size={22} strokeWidth={1.5} aria-hidden />
        <span className="text-xs">点击左侧文件查看改动 diff</span>
      </div>
    );
  } else if (openFiles.length === 0) {
    content = <CommitDetailPanel />;
  } else {
    content = (
      <PanelGroup direction="vertical" autoSaveId="fumigit-right">
        <Panel id="detail" order={1} defaultSize={55} minSize={20}>
          <CommitDetailPanel />
        </Panel>
        <HDivider />
        <Panel id="filediff" order={2} defaultSize={45} minSize={20}>
          <FileDiffTabs />
        </Panel>
      </PanelGroup>
    );
  }

  return (
    <div className="relative h-full">
      {content}
      <button
        onClick={() => closeRightPane()}
        title="关闭面板"
        aria-label="关闭面板"
        className="absolute right-1.5 top-1.5 z-20 rounded-md bg-panel/80 p-1 text-faint outline-none transition-colors hover:bg-hover hover:text-ink"
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
