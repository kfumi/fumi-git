// appearance 纯函数单测：步进夹取与浮点舍入（store 副作用不在此覆盖）
import { describe, expect, it, vi } from "vitest";
import { stepValue, FONT_SCALE, ZOOM } from "./appearance";

vi.mock("./lib/ipc", () => ({
  ipc: { setAppearance: vi.fn(async () => {}), getConfig: vi.fn(async () => ({})) },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

describe("stepValue", () => {
  it("按步进取整到 step 的小数位（0.1 → 一位）", () => {
    expect(stepValue(1, 1, ZOOM)).toBe(1.1);
    expect(stepValue(1.1, -1, ZOOM)).toBe(1);
  });

  it("按步进取整到 step 的小数位（0.05 → 两位），消除浮点累积误差", () => {
    expect(stepValue(1, 1, FONT_SCALE)).toBe(1.05);
    // 1.1 - 0.05 在浮点下是 1.0500000000000000something，必须舍入回 1.05
    expect(stepValue(1.1, -1, FONT_SCALE)).toBe(1.05);
    expect(stepValue(1.25, 1, FONT_SCALE)).toBe(1.3);
  });

  it("夹取在范围内（到达边界后不再变化）", () => {
    expect(stepValue(ZOOM.max, 1, ZOOM)).toBe(ZOOM.max);
    expect(stepValue(ZOOM.min, -1, ZOOM)).toBe(ZOOM.min);
    expect(stepValue(FONT_SCALE.max, 1, FONT_SCALE)).toBe(FONT_SCALE.max);
  });
});
