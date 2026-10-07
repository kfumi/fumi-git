// 冲突标记解析与拼装（二阶段票 03）—— 纯函数，vitest 直测。
// 只识别 git 标准冲突标记：`<<<<<<< ` 开行 / `=======` 独立行 / `>>>>>>> ` 开行。不处理嵌套（git 不产生）。

export type ConflictSide = "ours" | "theirs";

/** 标记行判定容忍行尾 CR（CRLF 文件，autocrlf 下 Windows 常见） */
const trimCr = (line: string) => line.replace(String.fromCharCode(13), "");
const isSep = (line: string) => trimCr(line) === "=======";
const isStart = (line: string) => trimCr(line).startsWith("<<<<<<<");
const isEnd = (line: string) => trimCr(line).startsWith(">>>>>>>");

export interface ConflictBlock {
  /** 冲突块我方内容（不含 <<<<<<< / ======= 标记行） */
  oursLines: string[];
  /** 冲突块对方内容（不含 ======= / >>>>>>> 标记行） */
  theirsLines: string[];
}

export interface ParsedConflict {
  blocks: ConflictBlock[];
  /** 非法结构（标记不配对等）时为 false，调用方应回退为普通文本展示 */
  wellFormed: boolean;
}

/**
 * 把含冲突标记的文件内容解析为块列表。
 * 标记外内容不进入结果（视图只展示冲突块）。
 */
export function parseConflictBlocks(content: string): ParsedConflict {
  const lines = content.split("\n");
  const blocks: ConflictBlock[] = [];
  let wellFormed = true;

  let i = 0;
  while (i < lines.length) {
    if (!isStart(lines[i])) {
      i++;
      continue;
    }
    // 进入冲突块：找 ======= 与 >>>>>>> 
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (sep === -1 && isSep(lines[j])) {
        sep = j;
      } else if (isEnd(lines[j])) {
        end = j;
        break;
      }
    }
    if (sep === -1 || end === -1 || end < sep) {
      wellFormed = false;
      break;
    }
    blocks.push({
      oursLines: lines.slice(i + 1, sep),
      theirsLines: lines.slice(sep + 1, end),
    });
    i = end + 1;
  }
  return { blocks, wellFormed };
}

/**
 * 把第 blockIndex 个冲突块替换为所选一侧内容，重新拼装完整文件。
 * choices 与标记行本身不保留；行尾结构（结尾换行）保持原样。
 * 解析非法或索引越界时返回原文（调用方据此提示错误而不是写坏文件）。
 */
export function applyBlockChoice(
  content: string,
  blockIndex: number,
  side: ConflictSide,
): string {
  const { blocks, wellFormed } = parseConflictBlocks(content);
  if (!wellFormed || blockIndex < 0 || blockIndex >= blocks.length) return content;

  const out: string[] = [];
  let lines = content.split("\n");
  let i = 0;
  let block = 0;
  let trailingNewline = content.endsWith("\n");
  if (trailingNewline) lines = lines.slice(0, -1);

  while (i < lines.length) {
    if (!isStart(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (sep === -1 && lines[j] === "=======") sep = j;
      else if (lines[j].startsWith(">>>>>>>")) {
        end = j;
        break;
      }
    }
    if (sep === -1 || end === -1) return content; // 理论不可达（wellFormed 已查）
    const chosen = side === "ours" ? blocks[block].oursLines : blocks[block].theirsLines;
    if (block === blockIndex) out.push(...chosen);
    else {
      // 未选择的块原样保留（含标记行）
      out.push(...lines.slice(i, end + 1));
    }
    block++;
    i = end + 1;
  }
  return out.join("\n") + (trailingNewline ? "\n" : "");
}
