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
    'Shell cwd is already set to the repository root; use `npm test` directly without `cd /d`.',
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
  // ephemeral 不进主历史：内容未变时每轮仍注入同一块，供模型可见
  if (content === state.workspaceAnchorHash) {
    return content;
  }
  state.workspaceAnchorHash = content;
  return content;
}
