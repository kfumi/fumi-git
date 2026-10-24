// 分支操作菜单构建（侧栏分支右键 / 工具栏分支下拉共用）
// 组序沿 ui-spec §4：移动引用 → 派生改动 → 破坏性，破坏性项沉底且 danger。
import type { MenuItem } from "./ContextMenu";

export interface BranchMenuActions {
  checkout: (branch: string) => void;
  createBranchFlow: (atCommit?: string, suggestName?: string) => void;
  mergeBranchFlow: (branch: string) => void;
  renameBranchFlow: (branch: string) => void;
  deleteBranchFlow: (branch: string) => void;
}

/** 本地分支操作菜单；current = 该分支是否为当前分支（迁出/合并/删除禁用并提示） */
export function localBranchMenu(
  branch: string,
  current: boolean,
  a: BranchMenuActions,
): MenuItem[] {
  const guard = current ? "当前分支" : undefined;
  return [
    { label: "迁出到该分支", disabled: current, hint: guard, onSelect: () => a.checkout(branch) },
    {
      label: "合并到当前分支…",
      disabled: current,
      hint: guard,
      onSelect: () => a.mergeBranchFlow(branch),
    },
    { kind: "separator" },
    { label: "新建分支…", hint: "基于当前 HEAD", onSelect: () => a.createBranchFlow() },
    { label: "重命名…", onSelect: () => a.renameBranchFlow(branch) },
    { kind: "separator" },
    {
      label: "删除该分支…",
      disabled: current,
      hint: guard,
      danger: true,
      onSelect: () => a.deleteBranchFlow(branch),
    },
  ];
}

/** 远程分支操作菜单：迁出 + 合并（rename/delete 仅对本地引用有效） */
export function remoteBranchMenu(
  fullName: string,
  tip: string,
  localNames: Set<string>,
  a: BranchMenuActions,
): MenuItem[] {
  const co = remoteCheckout(fullName, tip, localNames, a);
  return [
    { label: co.label, hint: co.hint, onSelect: co.run },
    { label: "合并到当前分支…", onSelect: () => a.mergeBranchFlow(fullName) },
  ];
}

/** 远程分支的「迁出」：有同名本地分支（origin/feat/x ↔ feat/x）直接切，否则弹「新建分支」预填短名、以其 tip 为起点（git switch 的 DWIM 显式化） */
export function remoteCheckout(
  fullName: string,
  tip: string,
  localNames: Set<string>,
  a: BranchMenuActions,
): { label: string; hint?: string; run: () => void } {
  const local = stripRemote(fullName);
  if (local && localNames.has(local)) {
    return { label: "迁出到该分支", hint: local, run: () => a.checkout(local) };
  }
  return { label: "迁出为新本地分支…", hint: local, run: () => a.createBranchFlow(tip, local) };
}

/** origin/feat/x → feat/x（远端名之后的剩余段） */
export function stripRemote(fullName: string): string {
  return fullName.split("/").slice(1).join("/");
}
