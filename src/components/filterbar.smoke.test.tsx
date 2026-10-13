// 渲染冒烟（ui-spec §1 筛选栏 + §4 菜单基元）：只断言 SSR 能保证的部分。
// 注意：zustand 交给 useSyncExternalStore 的 server 快照是**初始状态**，SSR 下筛选栏永远是默认态，
// 所以「随当前筛选变化的内容」由 lib/filterMenu.test.ts 的纯函数断言覆盖，store 流转由 repo.test.ts 覆盖。
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenu } from "./ContextMenu";
import { FilterBar } from "./FilterBar";

vi.mock("../lib/ipc", () => ({
  ipc: {},
  asGitError: async (e: unknown) => e,
  listenRepoChanged: vi.fn(async () => async () => {}),
}));

describe("筛选栏渲染冒烟（SSR 初始态）", () => {
  it("三块下拉按钮渲染默认值；无筛选时不出现「清除筛选」", () => {
    const html = renderToStaticMarkup(<FilterBar />);
    expect(html).toContain("分支：所有分支");
    expect(html).toContain("提交者：全部");
    expect(html).toContain("日期：全部时间");
    expect(html).not.toContain("清除筛选");
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(3);
  });
});

describe("菜单基元结构（SSR）", () => {
  it("勾选位 / 分组标题 / 提交数提示 / 底部输入框都渲染出来", () => {
    const html = renderToStaticMarkup(
      <ContextMenu
        x={0}
        y={0}
        items={[
          { kind: "header", label: "提交者" },
          { label: "全部", checked: true },
          { label: "kevin", hint: "3", title: "k@x.dev" },
        ]}
        onClose={() => {}}
        footer={<input placeholder="输入姓名或邮箱，回车过滤…" />}
      />,
    );
    expect(html).toContain("✓");
    expect(html).toContain("提交者");
    expect(html).toContain('title="k@x.dev"');
    expect(html).toContain(">3<");
    expect(html).toContain("输入姓名或邮箱，回车过滤…");
  });

  it("未出现 checked 项时不占勾选位（三份右键菜单排版不变）", () => {
    const html = renderToStaticMarkup(
      <ContextMenu x={0} y={0} items={[{ label: "检出" }, { label: "删除…", danger: true }]} onClose={() => {}} />,
    );
    expect(html).not.toContain("✓");
    expect(html).not.toContain("w-3.5");
  });
});
