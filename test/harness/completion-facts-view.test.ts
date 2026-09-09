import { describe, expect, it } from 'vitest';

import { CompletionFactsView } from '../../src/harness/completion-facts-view.js';
import { CompletionGate } from '../../src/harness/completion-gate.js';
import { OperationOutcomeLedger } from '../../src/harness/operation-outcome.js';
import { TaskAcceptanceTracker } from '../../src/harness/task-acceptance-tracker.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { ProjectCheckpointCompletion } from '../../src/types/runtime-checkpoint.js';

function completionSnapshot(): ProjectCheckpointCompletion {
  return {
    conditions: [{
      id: 'acceptance:npm-test',
      label: 'npm test',
      required: true,
      status: 'pending',
      source: 'user',
      sourceRef: 'acceptance:npm-test',
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
    expect(facts.completionDecisionInput({ answerReady: true }).conditions).toHaveLength(1);
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
    expect(new CompletionGate().evaluate(
      facts.completionDecisionInput({ answerReady: true }),
    ).action).toBe('complete');
  });

  it('keeps a restored passed condition authoritative over a fresh pending tracker', () => {
    const taskState = new TaskState(
      '实现功能；验收标准：依次运行 `npm test`',
    );
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
      taskAcceptance: new TaskAcceptanceTracker(
        '实现功能；验收标准：依次运行 `npm test`',
        ['npm test'],
      ),
      operationOutcomes,
      restoredCompletionConditions: [{
        id: 'acceptance:npm test',
        label: 'npm test',
        required: true,
        status: 'satisfied',
        source: 'user',
        sourceRef: 'acceptance:npm test',
        evidenceRefs: ['restored:test'],
      }],
      completionGateContinuationCount: 0,
    } as HarnessRunState;

    const facts = CompletionFactsView.fromHarnessRunState(state);
    expect(facts.verificationSignal()).toMatchObject({ status: 'passed', required: true });
    expect(new CompletionGate().evaluate(
      facts.completionDecisionInput({ answerReady: true }),
    ).action).toBe('complete');

    state.taskAcceptance!.recordRunCommand('npm test', false, 'new:test');
    expect(CompletionFactsView.fromHarnessRunState(state).conditionSnapshot())
      .toContainEqual(expect.objectContaining({
        id: 'acceptance:npm test',
        status: 'failed',
        evidenceRefs: ['new:test'],
      }));
  });
});
