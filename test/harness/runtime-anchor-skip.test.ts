import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { prepareRuntimeContextEphemeral } from '../../src/harness/harness-runtime-inject.js';
import {
  buildWorkspaceAnchorContent,
  prepareWorkspaceAnchorEphemeral,
} from '../../src/harness/workspace-anchor.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { spillToolOutputToSession } from '../../src/harness/tool-output-spill.js';
import { isFailedRunCommandToolResult } from '../../src/harness/failed-run-command.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function baseState(overrides: Partial<HarnessRunState> = {}): HarnessRunState {
  return {
    messages: [],
    tools: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    reasoningOnlyRecoveryCount: 0,
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: new TaskState('fix tests'),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    rebuildEscalationInjections: 0,
    rebuildEscalationInjectedThisRound: false,
    parallelBudgetBlockHintInjected: false,
    completionGateContinuationCount: 0,
    consecutiveNoToolRounds: 0,
    ...overrides,
  } as HarnessRunState;
}

describe('prepareRuntimeContextEphemeral', () => {
  it('injects once then skips identical snapshots', () => {
    const repo = new RepoContext();
    repo.recordToolResult(
      { id: 't1', name: 'read_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    const state = baseState({ repoContext: repo });

    const first = prepareRuntimeContextEphemeral(state);
    expect(first).toContain('[System Runtime State]');
    expect(first).toContain('src/a.ts');
    expect(state.runtimeStateHash).toBe(first);

    const second = prepareRuntimeContextEphemeral(state);
    expect(second).toBeNull();
  });

  it('re-injects when repo snapshot changes', () => {
    const repo = new RepoContext();
    repo.recordToolResult(
      { id: 't1', name: 'read_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    const state = baseState({ repoContext: repo });
    prepareRuntimeContextEphemeral(state);

    repo.recordToolResult(
      { id: 't2', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: 'fail', error: 'exit 1' },
    );
    const next = prepareRuntimeContextEphemeral(state);
    expect(next).toContain('npm test');
  });
});

describe('prepareWorkspaceAnchorEphemeral', () => {
  it('injects once then skips until root or references change', () => {
    const state = baseState({
      lockedWorkspaceRoot: 'E:\\proj',
      referenceReads: [],
      workspaceAnchorHash: '',
    });

    const first = prepareWorkspaceAnchorEphemeral(state);
    expect(first).toBe(buildWorkspaceAnchorContent('E:\\proj', []));
    expect(prepareWorkspaceAnchorEphemeral(state)).toBeNull();

    state.referenceReads = ['D:\\spec.md'];
    const changed = prepareWorkspaceAnchorEphemeral(state);
    expect(changed).toContain('D:\\spec.md');
  });
});

describe('spillToolOutputToSession', () => {
  it('writes full output outside the workspace tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ice-spill-'));
    const file = await spillToolOutputToSession({
      sessionDir: dir,
      sessionId: 'sess-1',
      toolCallId: 'tc-fail',
      content: 'FULL-LOG-BODY',
    });
    expect(file).toBeTruthy();
    expect(readFileSync(file!, 'utf8')).toBe('FULL-LOG-BODY');
  });
});

describe('isFailedRunCommandToolResult', () => {
  it('detects foreground command failures from the error prefix', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'npm test' } }],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: 'Tool execution error: Command failed (exit code: 1)\n\nFAIL src/a.test.ts',
      },
    ];
    expect(isFailedRunCommandToolResult(messages, 1)).toBe(true);
  });

  it('does not treat successful reads as failed commands', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'r1', content: 'export const x = 1;' },
    ];
    expect(isFailedRunCommandToolResult(messages, 1)).toBe(false);
  });
});
