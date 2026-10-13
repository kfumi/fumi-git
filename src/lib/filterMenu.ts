// 图谱筛选栏的条目与文案单点定义（ui-spec §1「图谱筛选栏」+ §4「菜单条目组织」）。
//
// 纯函数模块：只把「当前筛选 + 本地分支 + 提交身份 + 最近提交者」翻译成 MenuItem[] 与按钮文案，
// 不依赖 React、不读写 store、也不碰 DOM —— 组件只负责铺上下文、记 {x, y} 并渲染 <ContextMenu>。
// 与 lib/menus.ts 同构：文案、勾选态、禁用规则只有一处定义，可被 vitest 直接断言。
import type { MenuItem } from "../components/ContextMenu";
import type { CommitEntry, LogFilter, UserIdentity } from "./types";

/** 「最近提交者」条目（按已加载提交统计） */
export interface AuthorStat {
  name: string;
  email: string;
  count: number;
}

/** 三块下拉的身份（与参考截图一一对应） */
export type FilterMenuKey = "branch" | "author" | "date";

/** 时间档位：value 即后端 since 白名单，label 照参考截图 */
export const SINCE_ITEMS: { value: NonNullable<LogFilter["since"]>; label: string }[] = [
  { value: "day", label: "最近 24 小时" },
  { value: "week", label: "最近一周" },
  { value: "month", label: "最近一月" },
];

/** 是否有图谱筛选在生效（决定「清除筛选」入口与图谱空态文案） */
export function logFilterActive(f: LogFilter): boolean {
  return f.branch !== null || f.author !== null || f.since !== null;
}

/** 「只看我的」的过滤值：邮箱优先（唯一性更好），退化到姓名；都未配置则 null（入口禁用） */
export function authorPattern(identity: UserIdentity | null): string | null {
  return identity?.email ?? identity?.name ?? null;
}

/**
 * 「最近提交者」统计：按「姓名 + 邮箱」归并（同名不同人算两个），提交数倒序、同数量按姓名排。
 * 只统计**已加载**的提交——刻意不做全量历史扫描，所以标签是「最近」提交者。
 */
export function authorStatsOf(commits: CommitEntry[], top = 6): AuthorStat[] {
  const byKey = new Map<string, AuthorStat>();
  for (const c of commits) {
    const key = `${c.author_name}\u0000${c.author_email}`;
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { name: c.author_name, email: c.author_email, count: 1 });
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, top);
}

/** 三块筛选按钮的显示值（截图里的「提交者：全部」形态） */
export function filterButtonLabels(
  f: LogFilter,
  identity: UserIdentity | null,
): { branch: string; author: string; date: string } {
  const mine = authorPattern(identity);
  return {
    branch: f.branch ?? "所有分支",
    // 「只看我的」按当前值回显：邮箱/姓名可能与手输值相同，此处按同值判定
    author: f.author === null ? "全部" : mine !== null && f.author === mine ? "只看我的" : f.author,
    date: SINCE_ITEMS.find((s) => s.value === f.since)?.label ?? "全部时间",
  };
}

/** 构造下拉所需的上下文（组件从 store 取一次即可） */
export interface FilterMenuContext {
  logFilter: LogFilter;
  /** 本地分支短名（refs 中 kind=branch，已排序） */
  branches: string[];
  identity: UserIdentity | null;
  authorStats: AuthorStat[];
}

/** 选中某一项筛选：组件把它接到 store 的 setLogFilter（重取第一页） */
export type FilterPick = (patch: Partial<LogFilter>) => void;

/** 三块下拉的条目：勾选态、禁用规则、提交数提示与分组标题全在这里定 */
export function filterMenuItems(
  key: FilterMenuKey,
  ctx: FilterMenuContext,
  pick: FilterPick,
): MenuItem[] {
  const f = ctx.logFilter;
  if (key === "branch") {
    return [
      { kind: "header", label: "分支" },
      { label: "所有分支", checked: f.branch === null, onSelect: () => pick({ branch: null }) },
      // 分支筛选只列本地分支（远程 ref / 标签不作为筛选维度）
      ...ctx.branches.map(
        (b): MenuItem => ({
          label: b,
          checked: f.branch === b,
          onSelect: () => pick({ branch: b }),
        }),
      ),
    ];
  }
  if (key === "date") {
    return [
      { kind: "header", label: "日期" },
      { label: "全部时间", checked: f.since === null, onSelect: () => pick({ since: null }) },
      ...SINCE_ITEMS.map(
        (s): MenuItem => ({
          label: s.label,
          checked: f.since === s.value,
          onSelect: () => pick({ since: s.value }),
        }),
      ),
    ];
  }
  const mine = authorPattern(ctx.identity);
  const items: MenuItem[] = [
    { kind: "header", label: "提交者" },
    { label: "全部", checked: f.author === null, onSelect: () => pick({ author: null }) },
    {
      label: "只看我的",
      checked: mine !== null && f.author === mine,
      // 身份没解析出来时无从过滤（连姓名都没有），给 hint 指向配置
      disabled: mine === null,
      hint: mine === null ? "未配置 user.email" : undefined,
      onSelect: () => pick({ author: mine }),
    },
  ];
  // 「最近提交者」：按已加载提交统计（提交数走右侧 hint），点一行即按该人过滤
  if (ctx.authorStats.length > 0) {
    items.push({ kind: "separator" }, { kind: "header", label: "最近提交者" });
    for (const s of ctx.authorStats) {
      items.push({
        label: s.name,
        hint: String(s.count),
        title: s.email,
        // 生效中的提交者就是这一行 → 打勾（否则选了谁在菜单里毫无反馈）；
        // 「只看我的」那条自带勾，这里不重复勾同一个人的统计行
        checked:
          f.author !== null &&
          f.author !== mine &&
          (f.author === s.email || f.author === s.name),
        onSelect: () => pick({ author: s.email || s.name }),
      });
    }
  }
  return items;
}
