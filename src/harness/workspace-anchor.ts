import type { UnifiedMessage } from '../llm/types.js';
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

/** 每轮 LLM 调用前 upsert Sticky Workspace Anchor（压缩时保留）。 */
export function upsertWorkspaceAnchorMessage(
  messages: UnifiedMessage[],
  state: HarnessRunState,
): void {
  if (!state.lockedWorkspaceRoot) return;

  const content = buildWorkspaceAnchorContent(
    state.lockedWorkspaceRoot,
    state.referenceReads ?? [],
  );
  if (content === state.workspaceAnchorHash) return;
  state.workspaceAnchorHash = content;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === 'user'
      && typeof msg.content === 'string'
      && msg.content.startsWith(WORKSPACE_ANCHOR_OPEN)
    ) {
      messages.splice(i, 1);
    }
  }

  messages.push({
    role: 'user',
    content,
    preserveOnCompaction: true,
  });
}
