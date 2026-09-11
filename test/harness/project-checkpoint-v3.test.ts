import { describe, expect, it } from 'vitest';

import {
  cloneProjectCheckpointV3,
  isProjectCheckpointV3,
  type ProjectCheckpointV3,
} from '../../src/types/runtime-checkpoint.js';
import {
  emitLightweightSnapshotBoundary,
  onLightweightSnapshotBoundary,
} from '../../src/harness/checkpoint-snapshot.js';

function checkpoint(): ProjectCheckpointV3 {
  return {
    version: 3,
    identity: {
      checkpointId: 'checkpoint-1',
      projectId: 'project-1',
      sessionId: 'session-1',
    },
    execution: {
      taskState: {
        goal: 'Implement checkpoint v3',
        intent: 'edit',
        phase: 'editing',
        filesRead: [],
        filesChanged: ['src/types/runtime-checkpoint.ts'],
        commandsRun: [],
      },
      loopState: {
        currentRound: 2,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        lastInputTokens: 10,
        lastOutputTokens: 5,
        totalToolCalls: 1,
        startTime: 1,
      },
    },
    completion: {
      conditions: [{
        id: 'condition-1',
        label: 'Tests pass',
        required: true,
        status: 'pending',
        source: 'user',
        sourceRef: 'user:1',
        evidenceRefs: [],
      }],
      operationOutcomes: [{
        toolCallId: 'tool-1',
        toolName: 'write_file',
        status: 'completed',
        effect: 'local_change',
        risk: 'low',
        disposition: 'executed',
        scope: 'target:runtime-checkpoint.ts',
        receipt: { target: 'runtime-checkpoint.ts' },
        at: 1,
        reversibility: 'reversible',
      }],
    },
    conversation: {
      messages: [{ role: 'user', content: 'Implement it' }],
    },
    workspace: {
      root: 'D:/work/self/iceCoder',
      repoContext: {
        filesRead: [],
        filesChanged: ['src/types/runtime-checkpoint.ts'],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
    },
    memory: {
      payload: { providerSpecific: { rank: 1 } },
    },
    snapshotMeta: {
      capturedAt: '2026-09-09T00:00:00.000Z',
      trigger: 'manual',
      sequence: 1,
    },
    extensions: {
      futureProvider: { enabled: true, values: [1, 'two', null] },
    },
    migration: null,
  };
}

describe('ProjectCheckpointV3', () => {
  it('strictly validates required aggregate sections while passing unknown extensions', () => {
    const value = checkpoint();
    expect(isProjectCheckpointV3(value)).toBe(true);
    expect(isProjectCheckpointV3({ ...value, version: 2 })).toBe(false);
    expect(isProjectCheckpointV3({ ...value, completion: { conditions: [] } })).toBe(false);
    expect(isProjectCheckpointV3({
      ...value,
      execution: {
        ...value.execution,
        taskState: { ...value.execution.taskState, verificationStatus: 'passed' },
      },
    })).toBe(false);
    expect(isProjectCheckpointV3({
      ...value,
      extensions: { invalid: () => undefined },
    })).toBe(false);
  });

  it('deep-clones all core and extension state', () => {
    const original = checkpoint();
    const clone = cloneProjectCheckpointV3(original);

    (clone.extensions.futureProvider as { values: unknown[] }).values.push('changed');
    clone.completion.conditions[0].evidenceRefs.push('receipt:1');
    clone.conversation.messages[0].content = 'changed';

    expect(original.extensions.futureProvider).toEqual({
      enabled: true,
      values: [1, 'two', null],
    });
    expect(original.completion.conditions[0].evidenceRefs).toEqual([]);
    expect(original.conversation.messages[0].content).toBe('Implement it');
  });

  it('emits lightweight boundaries without retaining history', () => {
    emitLightweightSnapshotBoundary({ boundary: 'round_started', round: 1 });
    const seen: string[] = [];
    const unsubscribe = onLightweightSnapshotBoundary(event => seen.push(event.boundary));
    emitLightweightSnapshotBoundary({ boundary: 'tool_batch_completed' });
    unsubscribe();
    emitLightweightSnapshotBoundary({ boundary: 'gate_decision' });
    expect(seen).toEqual(['tool_batch_completed']);
  });

  it('does not emit a capture boundary while a tool batch is still running', () => {
    const seen: string[] = [];
    const unsubscribe = onLightweightSnapshotBoundary(event => seen.push(event.boundary));
    // Capture is only legal after the batch completes; mid-tool execution must not emit.
    unsubscribe();
    emitLightweightSnapshotBoundary({ boundary: 'tool_batch_completed' });
    expect(seen).toEqual([]);
  });
});
