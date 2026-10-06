// 展示格式化工具
import { BRANCH_PALETTE } from "../graph/lane";

export function relTime(unixSec: number): string {
  if (!unixSec) return "";
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} 个月前`;
  return `${Math.floor(diff / 86400 / 365)} 年前`;
}

export function absTime(unixSec: number): string {
  if (!unixSec) return "";
  return new Date(unixSec * 1000).toLocaleString("zh-CN", { hour12: false });
}

/** 头像底色与图谱分支色共用一个调色板（避免双份色板发散） */
export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) & 0x7fffffff;
  return BRANCH_PALETTE[h % BRANCH_PALETTE.length];
}

export function shortHash(id: string): string {
  return id.slice(0, 7);
}
