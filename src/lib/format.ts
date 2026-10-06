// 展示格式化工具
const PALETTE = ["#7C7FF2", "#3ECFB2", "#F0A64B", "#F2708A", "#B085F5", "#4EA8F0"];

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

export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) & 0x7fffffff;
  return PALETTE[h % PALETTE.length];
}

export function shortHash(id: string): string {
  return id.slice(0, 7);
}
