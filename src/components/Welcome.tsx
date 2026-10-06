// 欢迎页：首启引导 + 最近仓库（票 01）
import { useRepo } from "../stores/repo";
import { ipc } from "../lib/ipc";

export function Welcome() {
  const config = useRepo((s) => s.config);
  const openRepo = useRepo((s) => s.openRepo);
  const removeRecent = useRepo((s) => s.removeRecent);

  const pickAndOpen = async () => {
    const dir = await ipc.pickDirectory();
    if (dir) await openRepo(dir);
  };

  return (
    <main className="flex h-full flex-col items-center justify-center gap-6 bg-bg text-ink">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Fumi<span className="text-accent">Git</span>
        </h1>
        <p className="mt-2 text-dim">提交图谱是主角 —— 打开一个仓库开始</p>
      </div>

      <button
        onClick={() => void pickAndOpen()}
        className="h-9 rounded-lg bg-accent px-5 text-xs font-medium text-white hover:brightness-110"
      >
        打开仓库目录…
      </button>

      {config && config.recent_repos.length > 0 && (
        <div className="w-[420px]">
          <h4 className="mb-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
            最近打开
          </h4>
          <div className="overflow-hidden rounded-xl border border-brd bg-panel">
            {config.recent_repos.map((e) => (
              <div key={e.path} className="group flex items-center border-b border-brd-soft last:border-b-0">
                <button
                  onClick={() => void openRepo(e.path)}
                  className="flex-1 px-4 py-2.5 text-left text-xs hover:bg-hover"
                  title={e.path}
                >
                  <span className="font-medium">{e.name}</span>
                  <span className="ml-2 text-faint">{e.path}</span>
                </button>
                <button
                  onClick={() => void removeRecent(e.path)}
                  className="mr-3 hidden text-faint hover:text-bad group-hover:block"
                  title="从列表移除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
