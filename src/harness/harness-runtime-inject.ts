import type { HarnessRunState } from './harness-run-state.js';
import { CompletionFactsView } from './completion-facts-view.js';

/**
 * 构建 `[System Runtime State]` 易变块（发送管道注入，不进主历史）。
 * 无读/写/命令且无需验证时不注入。
 */
export function prepareRuntimeContextEphemeral(state: HarnessRunState): string | null {
  const repoSnapshot = state.repoContext.snapshot();
  const facts = CompletionFactsView.fromHarnessRunState(state);
  const taskSnapshot = facts.executionTaskSnapshot();
  const verification = facts.verificationSignal();
  const shouldInject = repoSnapshot.filesRead.length > 0
    || repoSnapshot.filesChanged.length > 0
    || repoSnapshot.commandsRun.length > 0
    || verification.status !== 'not_required'
    || facts.requiredBlockers().length > 0
    || facts.hasPendingOperation();
  if (!shouldInject) return null;

  const content = [
    '[System Runtime State]',
    '# Runtime State',
    JSON.stringify(taskSnapshot, null, 2),
    '',
    '# Completion Facts',
    JSON.stringify({
      verification,
      requiredBlockers: facts.requiredBlockers(),
      pendingOperation: facts.hasPendingOperation(),
    }, null, 2),
    '',
    '# Repo Context',
    JSON.stringify(repoSnapshot, null, 2),
    '[/System Runtime State]',
  ].join('\n');

  state.runtimeStateHash = content;
  return content;
}