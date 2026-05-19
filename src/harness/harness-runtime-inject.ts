import type { UnifiedMessage } from '../llm/types.js';
import type { HarnessRunState } from './harness-run-state.js';

/**
 * LLM 调用前注入 `[System Runtime State]`：TaskState + RepoContext 快照。
 * 无读/写/命令且无需验证时不注入；内容未变（hash）则去重旧块后覆盖。
 */
export function upsertRuntimeContextMessage(messages: UnifiedMessage[], state: HarnessRunState): void {
  const repoSnapshot = state.repoContext.snapshot();
  const taskSnapshot = state.taskState.snapshot();
  const shouldInject = repoSnapshot.filesRead.length > 0
    || repoSnapshot.filesChanged.length > 0
    || repoSnapshot.commandsRun.length > 0
    || taskSnapshot.verificationRequired;
  if (!shouldInject) return;

  const content = [
    '[System Runtime State]',
    '# Runtime State',
    JSON.stringify(taskSnapshot, null, 2),
    '',
    '# Repo Context',
    JSON.stringify(repoSnapshot, null, 2),
    '[/System Runtime State]',
  ].join('\n');

  if (content === state.runtimeStateHash) return;
  state.runtimeStateHash = content;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('[System Runtime State]')) {
      messages.splice(i, 1);
    }
  }
  messages.push({ role: 'user', content });
}
