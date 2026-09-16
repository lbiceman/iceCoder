import { describe, expect, it } from 'vitest';

import { CompletionFactsView } from '../../src/harness/completion-facts-view.js';
import { OperationOutcomeLedger } from '../../src/harness/operation-outcome.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { ProjectCheckpointCompletion } from '../../src/types/runtime-checkpoint.js';

function completionSnapshot(): ProjectCheckpointCompletion {
  return {
    conditions: [{
      id: 'verification:npm-test',
      label: 'npm test',
      required: true,
      status: 'pending',
      source: 'user',
      sourceRef: 'verification:npm-test',
      evidenceRefs: [],
    }],
    operationOutcomes: [{
      toolCallId: 'background:1',
      toolName: 'run_command',
      status: 'pending',
      effect: 'execute',
      risk: 'low',
      disposition: 'executed',
      scope: 'verification:test',
      at: 1,
    }],
  };
}

describe('CompletionFactsView', () => {
  it('builds an immutable query view from a V3 completion snapshot', () => {
    const snapshot = completionSnapshot();
    const facts = CompletionFactsView.fromCompletionSnapshot(snapshot);
    snapshot.conditions[0].status = 'satisfied';
    snapshot.operationOutcomes[0].status = 'completed';

    expect(facts.requiredBlockers()).toHaveLength(1);
    expect(facts.hasPendingOperation()).toBe(true);
    expect(facts.verificationSignal()).toMatchObject({
      status: 'pending',
      required: true,
    });
    expect(facts.conditionSnapshot()).toHaveLength(1);
  });

  it('supports scoped failures and pending operations', () => {
    const snapshot = completionSnapshot();
    snapshot.operationOutcomes.push({
      toolCallId: 'failure:1',
      toolName: 'deploy',
      status: 'failed',
      effect: 'external_change',
      risk: 'high',
      disposition: 'execution_fail',
      scope: 'deploy:prod',
      at: 2,
    });
    const facts = CompletionFactsView.fromCompletionSnapshot(snapshot);

    expect(facts.latestFailure('deploy')).toMatchObject({ toolCallId: 'failure:1' });
    expect(facts.latestFailure('verification')).toBeUndefined();
    expect(facts.hasPendingOperation('verification')).toBe(true);
    expect(facts.hasPendingOperation('deploy')).toBe(false);
  });

  it('does not infer a hard condition from an ordinary source edit', () => {
    const taskState = new TaskState('implement feature');
    taskState.recordToolResult(
      { id: 'write:1', name: 'write_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    const state = {
      taskState,
      operationOutcomes: new OperationOutcomeLedger(),
      completionGateContinuationCount: 0,
    } as HarnessRunState;

    const facts = CompletionFactsView.fromHarnessRunState(state);
    expect(facts.verificationSignal()).toMatchObject({
      status: 'not_required',
      required: false,
    });
    expect(facts.requiredBlockers()).toEqual([]);
  });

  it('keeps a restored passed condition even when the runtime tracker no longer exists', () => {
    const taskState = new TaskState('实现功能。完成条件：必须运行 `npm test`。');
    const operationOutcomes = new OperationOutcomeLedger();
    operationOutcomes.record({
      toolCallId: 'restored:test',
      toolName: 'run_command',
      status: 'completed',
      effect: 'execute',
      risk: 'low',
      disposition: 'executed',
      scope: 'target:npm test',
      receipt: { exitCode: 0 },
      at: 1,
    });
    const state = {
      taskState,
      operationOutcomes,
      restoredCompletionConditions: [{
        id: 'verification:npm test',
        label: 'npm test',
        required: true,
        status: 'satisfied',
        source: 'user',
        sourceRef: 'verification:npm test',
        evidenceRefs: ['restored:test'],
      }],
      completionGateContinuationCount: 0,
    } as HarnessRunState;

    const facts = CompletionFactsView.fromHarnessRunState(state);
    expect(facts.verificationSignal()).toMatchObject({ status: 'passed', required: true });
    expect(facts.conditionSnapshot()).toContainEqual(expect.objectContaining({
      id: 'verification:npm test',
      status: 'satisfied',
    }));
  });
});
