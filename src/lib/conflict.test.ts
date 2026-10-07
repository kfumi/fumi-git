import { describe, expect, it } from "vitest";
import { applyBlockChoice, parseConflictBlocks } from "./conflict";

const content = [
  "header",
  "<<<<<<< HEAD",
  "ours 1",
  "ours 2",
  "=======",
  "theirs 1",
  ">>>>>>> feat",
  "middle",
  "<<<<<<< HEAD",
  "ours B",
  "=======",
  "theirs B",
  ">>>>>>> feat",
  "footer",
].join("\n");

describe("parseConflictBlocks", () => {
  it("解析多个冲突块，标记行不进内容", () => {
    const { blocks, wellFormed } = parseConflictBlocks(content);
    expect(wellFormed).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].oursLines).toEqual(["ours 1", "ours 2"]);
    expect(blocks[0].theirsLines).toEqual(["theirs 1"]);
    expect(blocks[1].oursLines).toEqual(["ours B"]);
  });

  it("CRLF 行尾的标记也能解析", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const crlf = ["h" + CR, "<<<<<<< HEAD" + CR, "ours" + CR, "=======" + CR, "theirs" + CR, ">>>>>>> f" + CR, "" + CR].join(LF);
    const { blocks, wellFormed } = parseConflictBlocks(crlf);
    expect(wellFormed).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].oursLines).toEqual(["ours" + CR]);
  });

  it("空块（两侧都无内容）解析与取舍", () => {
    const LF = String.fromCharCode(10);
    const empty = ["a", "<<<<<<< HEAD", "=======", ">>>>>>> f", "b"].join(LF) + LF;
    const { blocks } = parseConflictBlocks(empty);
    expect(blocks[0].oursLines).toEqual([]);
    expect(applyBlockChoice(empty, 0, "theirs")).toBe("a" + LF + "b" + LF);
    expect(applyBlockChoice(empty, 0, "ours")).toBe("a" + LF + "b" + LF);
  });

  it("无标记 / 标记不配对：blocks 为空或 wellFormed=false", () => {
    expect(parseConflictBlocks("no markers here").blocks).toHaveLength(0);
    const broken = ["<<<<<<< HEAD", "ours", "footer"].join("\n");
    const r = parseConflictBlocks(broken);
    expect(r.wellFormed).toBe(false);
  });
});

describe("applyBlockChoice", () => {
  it("选中块替换为所选一侧，其余块原样保留", () => {
    const out = applyBlockChoice(content, 0, "theirs");
    expect(out).toContain("theirs 1");
    expect(out).not.toContain("ours 1");
    expect(out).toContain("ours B"); // 第二块未动
    expect(out).toContain("<<<<<<< HEAD"); // 标记仍在
    expect(out.startsWith("header\n")).toBe(true);
    expect(out.endsWith("footer")).toBe(true);
  });

  it("逐块解决：全部选择后不再有标记（每解决一块，剩余块索引前移）", () => {
    const step1 = applyBlockChoice(content, 0, "ours");
    expect(step1).toContain("ours 1\nours 2");
    expect(step1).not.toContain("theirs 1");
    // 第一块已解决，原第二块现在只剩一个块（索引 0）
    const step2 = applyBlockChoice(step1, 0, "theirs");
    expect(step2).not.toContain("<<<<<<<");
    expect(step2).toContain("ours 1\nours 2\nmiddle\ntheirs B");
  });

  it("结尾换行保持原样；越界/非法输入返回原文", () => {
    expect(applyBlockChoice(content + "\n", 0, "ours").endsWith("\n")).toBe(true);
    expect(applyBlockChoice(content, 9, "ours")).toBe(content);
    expect(applyBlockChoice("<<<<<<< HEAD\nbroken", 0, "ours")).toBe("<<<<<<< HEAD\nbroken");
  });
});
