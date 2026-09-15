import type { HarnessRunState } from './harness-run-state.js';

export const WORKSPACE_ANCHOR_OPEN = '[Workspace Anchor]';
export const WORKSPACE_ANCHOR_CLOSE = '[/Workspace Anchor]';

export function buildWorkspaceAnchorContent(
  lockedRoot: string,
  referenceReads: string[],
): string {
  const lines = [
    WORKSPACE_ANCHOR_OPEN,
    `Repository root: ${lockedRoot}`,
    'All write/edit/run_command operations default to this directory unless reading reference files.',
    'Shell cwd is already set to the repository root. Run verification commands from here without `cd`; if the user specified a command, use that exact command.',
  ];
  if (referenceReads.length > 0) {
    lines.push('Reference reads (not workspace root):');
    for (const ref of referenceReads) {
      lines.push(`- ${ref}`);
    }
  }
  lines.push(WORKSPACE_ANCHOR_CLOSE);
  return lines.join('\n');
}

/** 构建 Sticky Workspace Anchor 易变块（发送管道注入，不进主历史）。 */
export function prepareWorkspaceAnchorEphemeral(state: HarnessRunState): string | null {
  if (!state.lockedWorkspaceRoot) return null;

  const content = buildWorkspaceAnchorContent(
    state.lockedWorkspaceRoot,
    state.referenceReads ?? [],
  );
  // ephemeral 不进主历史。cwd 已在 Environment 段；root/referenceReads 未变则跳过，
  // 避免每轮重复贴同一块打穿可缓存前缀。
  if (content === state.workspaceAnchorHash) return null;
  state.workspaceAnchorHash = content;
  return content;
}
