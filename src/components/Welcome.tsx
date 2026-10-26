// 欢迎页：首启引导 + 最近仓库（票 01）
// 背景母题 = 一幅极简提交图谱（与 Canvas 图谱同一套 lane 几何 / 分支调色板 / 空心节点），
// 边缘用 mask 融进底色——只留氛围，不与前景争夺注意力。
import { FolderOpen, X } from "lucide-react";
import { useRepo } from "../stores/repo";
import logo from "../assets/logo.png";

export function Welcome() {
  const config = useRepo((s) => s.config);
  const openRepo = useRepo((s) => s.openRepo);
  const removeRecent = useRepo((s) => s.removeRecent);
  const pickAndOpen = useRepo((s) => s.pickAndOpenRepo);

  return (
    <main
      className="relative flex h-full flex-col items-center justify-center gap-7 overflow-hidden bg-bg text-ink"
      style={{
        backgroundImage:
          "radial-gradient(560px 320px at 50% 38%, var(--accent-soft), transparent 70%)",
      }}
    >
      <GraphMotif />
      <div className="rise-in relative text-center">
        <img src={logo} alt="" className="mx-auto mb-4 h-14 w-14" />
        <h1 className="text-3xl font-semibold tracking-tight">
          Fumi<span className="text-accent-ink">Git</span>
        </h1>
        <p className="mt-2 text-[0.8125rem] text-dim">提交图谱是主角 —— 打开一个仓库开始</p>
      </div>

      <button
        onClick={() => void pickAndOpen()}
        style={{ animationDelay: "70ms" }}
        className="rise-in btn-primary relative h-9 rounded-lg px-5 text-[0.8125rem]"
      >
        <FolderOpen size={15} aria-hidden />
        打开仓库目录…
      </button>

      {config && config.recent_repos.length > 0 && (
        <div style={{ animationDelay: "140ms" }} className="rise-in relative w-[520px]">
          <h4 className="section-label mb-1.5 px-1">最近打开</h4>
          <div className="overflow-hidden rounded-xl border border-brd bg-panel shadow-card">
            {config.recent_repos.map((e) => (
              <div key={e.path} className="group flex items-center border-b border-brd-soft last:border-b-0">
                <button
                  onClick={() => void openRepo(e.path)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-4 py-2.5 text-left text-xs transition-colors hover:bg-hover"
                  title={e.path}
                >
                  <span className="shrink-0 font-medium">{e.name}</span>
                  <span className="truncate text-faint transition-colors group-hover:text-dim">
                    {e.path}
                  </span>
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

/* 背景图谱：行距对齐真实图谱节奏（112px = 2 行），lane 间距放大为背景尺度的 90px。
   曲线沿用应用的限幅贝塞尔（控制点近端点），节点空心圆环 r=5、描边 1.6。
   「HEAD」在主干中段：填充色 + 柔光晕，与图谱选中/HEAD 画法一致。 */
const LANE_STROKE = 1.6;
const MOTIF_PATHS = [
  // 主干
  { d: "M520 40 V720", c: "#7C7FF2", o: 0.34 },
  // 右侧分支：分出 → 空行 → 并回主干
  { d: "M520 152 C520 192 610 192 610 232 L610 520 C610 560 520 560 520 600", c: "#3ECFB2", o: 0.28 },
  // 右侧长分支：一路下行（在视野外继续）
  { d: "M520 264 C520 304 700 304 700 344 L700 720", c: "#F0A64B", o: 0.28 },
  // 左侧分支：不并回
  { d: "M520 376 C520 416 430 416 430 456 L430 720", c: "#B085F5", o: 0.28 },
  // 右上汇入：外部 lane 并进主干
  { d: "M790 40 L790 408 C790 448 520 448 520 488", c: "#4EA8F0", o: 0.28 },
  // 左侧二级分支（从左侧分支再分出）
  { d: "M430 600 C430 640 340 640 340 680 L340 720", c: "#F2708A", o: 0.24 },
];
const MOTIF_NODES: Array<[number, number, string]> = [
  [520, 152, "#7C7FF2"],
  [520, 264, "#7C7FF2"],
  [520, 376, "#7C7FF2"],
  [520, 600, "#7C7FF2"],
  [520, 712, "#7C7FF2"],
  [610, 376, "#3ECFB2"],
  [610, 488, "#3ECFB2"],
  [700, 432, "#F0A64B"],
  [700, 544, "#F0A64B"],
  [430, 544, "#B085F5"],
  [790, 152, "#4EA8F0"],
  [790, 264, "#4EA8F0"],
  [340, 712, "#F2708A"],
];

function GraphMotif() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 1200 760"
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-50"
      style={{
        WebkitMaskImage:
          "radial-gradient(ellipse 64% 56% at 50% 44%, #000 28%, transparent 76%)",
        maskImage: "radial-gradient(ellipse 64% 56% at 50% 44%, #000 28%, transparent 76%)",
      }}
    >
      <g fill="none" strokeWidth={LANE_STROKE}>
        {MOTIF_PATHS.map((p, i) => (
          <path key={i} d={p.d} stroke={p.c} opacity={p.o} />
        ))}
        {MOTIF_NODES.map(([x, y, c], i) => (
          <circle key={i} cx={x} cy={y} r={5} stroke={c} opacity={0.4} />
        ))}
        {/* 主干 HEAD：填充 + 同色柔光晕（与图谱 HEAD 画法一致） */}
        <circle cx={520} cy={488} r={11} stroke="none" fill="#7C7FF2" opacity={0.13} />
        <circle cx={520} cy={488} r={5} stroke="none" fill="#7C7FF2" opacity={0.5} />
      </g>
    </svg>
  );
}
