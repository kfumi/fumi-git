// 图谱筛选下拉与按钮文案（lib/filterMenu.ts）：条目、勾选态、禁用规则、计数提示的纯函数断言。
// 这里覆盖参考截图里三块筛选的「内容」；store 侧的重取/透传见 stores/repo.test.ts。
import { describe, expect, it } from "vitest";
import type { MenuAction, MenuHeader, MenuItem } from "../components/ContextMenu";
import type { LogFilter } from "./types";
import {
  authorPattern,
  authorStatsOf,
  filterButtonLabels,
  filterMenuItems,
  logFilterActive,
  type AuthorStat,
  type FilterMenuContext,
} from "./filterMenu";
import type { CommitEntry } from "./types";

const NONE: LogFilter = { branch: null, author: null, since: null };

const acts = (items: MenuItem[]): MenuAction[] =>
  items.filter((i): i is MenuAction => i.kind === undefined || i.kind === "item");
const headers = (items: MenuItem[]): string[] =>
  items.filter((i): i is MenuHeader => i.kind === "header").map((i) => i.label);
const sepCount = (items: MenuItem[]) => items.filter((i) => i.kind === "separator").length;

function find(items: MenuItem[], label: string): MenuAction {
  const hit = acts(items).find((i) => i.label === label);
  if (!hit) throw new Error(`下拉里没有「${label}」项`);
  return hit;
}

const ctx = (over: Partial<FilterMenuContext> = {}): FilterMenuContext => ({
  logFilter: { ...NONE },
  branches: ["feat", "main"],
  identity: { name: "林一帆", email: "lin@x.dev" },
  authorStats: [],
  ...over,
});

describe("filterMenuItems：分支块", () => {
  it("分组标题 + 所有分支 + 本地分支列表，按当前值勾选", () => {
    const picks: Partial<LogFilter>[] = [];
    const items = filterMenuItems(
      "branch",
      ctx({ logFilter: { ...NONE, branch: "main" } }),
      (p) => picks.push(p),
    );

    expect(headers(items)).toEqual(["分支"]);
    expect(acts(items).map((i) => i.label)).toEqual(["所有分支", "feat", "main"]);
    expect(find(items, "所有分支").checked).toBe(false);
    expect(find(items, "main").checked).toBe(true);
    expect(find(items, "feat").checked).toBe(false);

    find(items, "feat").onSelect?.();
    find(items, "所有分支").onSelect?.();
    expect(picks).toEqual([{ branch: "feat" }, { branch: null }]);
  });
});

describe("filterMenuItems：日期块", () => {
  it("全部时间 + 三档时间，按当前档勾选", () => {
    const picks: Partial<LogFilter>[] = [];
    const items = filterMenuItems(
      "date",
      ctx({ logFilter: { ...NONE, since: "week" } }),
      (p) => picks.push(p),
    );

    expect(acts(items).map((i) => i.label)).toEqual([
      "全部时间",
      "最近 24 小时",
      "最近一周",
      "最近一月",
    ]);
    expect(find(items, "最近一周").checked).toBe(true);
    expect(find(items, "全部时间").checked).toBe(false);

    find(items, "最近 24 小时").onSelect?.();
    find(items, "全部时间").onSelect?.();
    expect(picks).toEqual([{ since: "day" }, { since: null }]);
  });
});

describe("filterMenuItems：提交者块", () => {
  it("身份缺失时「只看我的」禁用并给 hint，指回配置", () => {
    const items = filterMenuItems("author", ctx({ identity: null }), () => {});
    expect(headers(items)).toEqual(["提交者"]);
    const mine = find(items, "只看我的");
    expect(mine.disabled).toBe(true);
    expect(mine.hint).toBe("未配置 user.email");
    expect(mine.checked).toBe(false);
  });

  it("「只看我的」按身份过滤值（邮箱优先）勾选与取值", () => {
    const picks: Partial<LogFilter>[] = [];
    const items = filterMenuItems(
      "author",
      ctx({ logFilter: { ...NONE, author: "lin@x.dev" } }),
      (p) => picks.push(p),
    );

    const mine = find(items, "只看我的");
    expect(mine.disabled).toBe(false);
    expect(mine.checked).toBe(true);
    expect(find(items, "全部").checked).toBe(false);

    mine.onSelect?.();
    expect(picks).toEqual([{ author: "lin@x.dev" }]);
  });

  it("最近提交者：分组标题 + 提交数 hint + 邮箱 tooltip，点行按该人过滤", () => {
    const stats: AuthorStat[] = [
      { name: "vzi777", email: "v@x.dev", count: 50 },
      { name: "kuangdi", email: "k@x.dev", count: 12 },
    ];
    const picks: Partial<LogFilter>[] = [];
    const items = filterMenuItems("author", ctx({ authorStats: stats }), (p) => picks.push(p));

    expect(headers(items)).toEqual(["提交者", "最近提交者"]);
    expect(sepCount(items)).toBe(1);
    expect(find(items, "vzi777").hint).toBe("50");
    expect(find(items, "kuangdi").title).toBe("k@x.dev");

    find(items, "kuangdi").onSelect?.();
    expect(picks).toEqual([{ author: "k@x.dev" }]);
  });

  it("没有统计时不出现「最近提交者」标题与分隔线", () => {
    const items = filterMenuItems("author", ctx(), () => {});
    expect(headers(items)).toEqual(["提交者"]);
    expect(sepCount(items)).toBe(0);
  });
});

describe("filterButtonLabels：按钮显示值", () => {
  const id = { name: "林一帆", email: "lin@x.dev" };

  it("默认态照截图取值，全部走中文档位文案", () => {
    expect(filterButtonLabels(NONE, id)).toEqual({
      branch: "所有分支",
      author: "全部",
      date: "全部时间",
    });
  });

  it("有筛选时回显分支名 / 「只看我的」/ 档位文案，自定义值原样显示", () => {
    expect(filterButtonLabels({ branch: "feat", author: "lin@x.dev", since: "month" }, id)).toEqual({
      branch: "feat",
      author: "只看我的",
      date: "最近一月",
    });
    expect(filterButtonLabels({ branch: null, author: "kevin", since: null }, id).author).toBe("kevin");
    // 身份缺失时不会误判成「只看我的」
    expect(filterButtonLabels({ branch: null, author: "kevin", since: null }, null).author).toBe(
      "kevin",
    );
    expect(filterButtonLabels(NONE, null).author).toBe("全部");
  });
});

describe("logFilterActive / authorPattern / authorStatsOf", () => {
  it("logFilterActive：任一维度被设定即生效", () => {
    expect(logFilterActive(NONE)).toBe(false);
    expect(logFilterActive({ ...NONE, branch: "main" })).toBe(true);
    expect(logFilterActive({ ...NONE, author: "kevin" })).toBe(true);
    expect(logFilterActive({ ...NONE, since: "week" })).toBe(true);
  });

  it("authorPattern：邮箱优先、退化到姓名、都未配置则 null", () => {
    expect(authorPattern({ name: "林一帆", email: "lin@x.dev" })).toBe("lin@x.dev");
    expect(authorPattern({ name: "林一帆", email: null })).toBe("林一帆");
    expect(authorPattern({ name: null, email: null })).toBeNull();
    expect(authorPattern(null)).toBeNull();
  });

  it("authorStatsOf：提交数倒序、按邮箱区分同名、可截断", () => {
    const mk = (id: string, name: string, email: string): CommitEntry => ({
      id,
      short_id: id,
      parents: [],
      author_name: name,
      author_email: email,
      time: 0,
      subject: `s${id}`,
      refs: [],
    });
    const commits = [
      mk("1", "kevin", "k@x.dev"),
      mk("2", "kevin", "k@x.dev"),
      mk("3", "林一帆", "lin@x.dev"),
      mk("4", "kevin", "k@x.dev"),
      mk("5", "kevin", "k2@x.dev"),
    ];

    const stats = authorStatsOf(commits);
    expect(stats).toHaveLength(3);
    expect(stats[0]).toEqual({ name: "kevin", email: "k@x.dev", count: 3 });
    // 同名不同邮箱是两个人，剩余两项都各 1 条提交
    expect(stats.slice(1).map((s) => s.email).sort()).toEqual(["k2@x.dev", "lin@x.dev"]);
    expect(authorStatsOf(commits, 2)).toHaveLength(2);
  });
});

describe("filterMenuItems：勾选态", () => {
  const withMe: AuthorStat[] = [
    { name: "vzi777", email: "v@x.dev", count: 50 },
    { name: "kuangdi", email: "k@x.dev", count: 12 },
    { name: "林一帆", email: "lin@x.dev", count: 3 },
  ];

  it("生效中的自定义提交者会打勾（选了谁得有反馈）", () => {
    const items = filterMenuItems(
      "author",
      ctx({ logFilter: { ...NONE, author: "k@x.dev" }, authorStats: withMe }),
      () => {},
    );
    expect(find(items, "kuangdi").checked).toBe(true);
    expect(find(items, "vzi777").checked).toBe(false);
    expect(find(items, "全部").checked).toBe(false);
    expect(find(items, "只看我的").checked).toBe(false);
  });

  it("生效的是「只看我的」时只勾那一项，不重复勾同一个人的统计行", () => {
    const items = filterMenuItems(
      "author",
      ctx({ logFilter: { ...NONE, author: "lin@x.dev" }, authorStats: withMe }),
      () => {},
    );
    expect(find(items, "只看我的").checked).toBe(true);
    expect(find(items, "林一帆").checked).toBe(false);
  });
});
