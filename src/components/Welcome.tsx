// 欢迎页：首启引导 + 最近仓库（票 01）
import { FolderOpen, X } from "lucide-react";
import { useRepo } from "../stores/repo";
import { ipc } from "../lib/ipc";
import logo from "../assets/logo.png";

export function Welcome() {
  const config = useRepo((s) => s.config);
  const openRepo = useRepo((s) => s.openRepo);
  const removeRecent = useRepo((s) => s.removeRecent);

  const pickAndOpen = async () => {
    const dir = await ipc.pickDirectory();
    if (dir) await openRepo(dir);
  };

  return (
    <main
      className="flex h-full flex-col items-center justify-center gap-7 bg-bg text-ink"
      style={{
        backgroundImage:
          "radial-gradient(560px 320px at 50% 38%, var(--accent-soft), transparent 70%)",
      }}
    >
      <div className="text-center">
        <img src={logo} alt="" className="mx-auto mb-4 h-14 w-14" />
        <h1 className="text-3xl font-semibold tracking-tight">
          Fumi<span className="text-accent-ink">Git</span>
        </h1>
        <p className="mt-2 text-[13px] text-dim">提交图谱是主角 —— 打开一个仓库开始</p>
      </div>

      <button onClick={() => void pickAndOpen()} className="btn-primary h-9 rounded-lg px-5 text-[13px]">
        <FolderOpen size={15} aria-hidden />
        打开仓库目录…
      </button>

      {config && config.recent_repos.length > 0 && (
        <div className="w-[420px]">
          <h4 className="section-label mb-1.5 px-1">最近打开</h4>
          <div className="overflow-hidden rounded-xl border border-brd bg-panel shadow-card">
            {config.recent_repos.map((e) => (
              <div key={e.path} className="group flex items-center border-b border-brd-soft last:border-b-0">
                <button
                  onClick={() => void openRepo(e.path)}
                  className="flex-1 px-4 py-2.5 text-left text-xs transition-colors hover:bg-hover"
                  title={e.path}
                >
                  <span className="font-medium">{e.name}</span>
                  <span className="ml-2 text-faint">{e.path}</span>
                </button>
                <button
                  onClick={() => void removeRecent(e.path)}
                  className="mr-3 hidden rounded p-0.5 text-faint transition-colors hover:text-bad group-hover:block"
                  title="从列表移除"
                  aria-label={`从列表移除 ${e.name}`}
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
