// 中栏：改动 / 历史 双 tab（GitHub Desktop 式）。历史默认——提交图谱是主角
import { FileDiff, GitBranch } from "lucide-react";
import { useRepo } from "../stores/repo";
import { GraphList } from "./GraphList";
import { ChangesPanel } from "./StagePanel";

export function MainArea() {
  const tab = useRepo((s) => s.mainTab);
  const setMainTab = useRepo((s) => s.setMainTab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-brd bg-panel px-2">
        <TabBtn
          active={tab === "changes"}
          onClick={() => setMainTab("changes")}
          icon={<FileDiff size={13} aria-hidden />}
          label="改动"
        />
        <TabBtn
          active={tab === "history"}
          onClick={() => setMainTab("history")}
          icon={<GitBranch size={13} aria-hidden />}
          label="历史"
        />
      </div>
      <div className="min-h-0 flex-1">
        {/* 两个 tab 都保持挂载：切回历史不丢图谱滚动位置 */}
        <div className={tab === "history" ? "h-full" : "hidden"}>
          <GraphList />
        </div>
        <div className={tab === "changes" ? "h-full" : "hidden"}>
          <ChangesPanel />
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors " +
        (active
          ? "bg-accent-soft font-semibold text-accent-ink shadow-[inset_0_0_0_1px_var(--accent)]"
          : "text-dim hover:bg-hover hover:text-ink")
      }
    >
      {icon}
      {label}
    </button>
  );
}
