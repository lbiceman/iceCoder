import { describe, expect, it } from 'vitest';

import {
  adaptCombinedCheckpoint,
  adaptLegacyCheckpoint,
} from '../../src/harness/legacy-checkpoint-adapter.js';
import { isProjectCheckpointV3 } from '../../src/types/runtime-checkpoint.js';

const at = '2026-09-09T01:02:03.000Z';

function task(verificationStatus: 'not_required' | 'required' | 'passed' | 'failed' = 'required') {
  return {
    goal: 'ship adapter',
    intent: 'edit',
    phase: 'verification',
    filesRead: ['src/a.ts'],
    filesChanged: ['src/a.ts'],
    commandsRun: ['npm test'],
    verificationRequired: verificationStatus !== 'not_required',
    verificationStatus,
  };
}

function repo() {
  return {
    filesRead: ['src/a.ts'],
    filesChanged: ['src/a.ts'],
    commandsRun: ['npm test'],
    testCommands: ['npm test'],
    recentDiagnostics: [],
  };
}

function combined(
  status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted' = 'running',
  verificationStatus: 'not_required' | 'required' | 'passed' | 'failed' = 'required',
) {
  return {
    version: 1,
    taskId: 'task-1',
    status,
    userGoal: 'ship adapter',
    phase: 'verification',
    taskState: task(verificationStatus),
    repoContext: repo(),
    failedToolCalls: [],
    messageCount: 2,
    loop: {
      currentRound: 4,
      totalToolCalls: 3,
      totalInputTokens: 100,
      totalOutputTokens: 40,
    },
    createdAt: at,
    updatedAt: at,
  };
}

describe('legacy checkpoint adapter', () => {
  it('maps combined TaskCheckpoint v1 + runtimeV2 and explicit acceptance states', () => {
    const input = {
      ...combined('running', 'passed'),
      runtimeV2: {
        runtimeVersion: 2,
        verificationPending: false,
        currentStepId: 'verify',
        currentStepTitle: 'Run checks',
        lastTrigger: 'verification_started',
        v2UpdatedAt: at,
        acceptanceGate: {
          active: true,
          commands: [
            { key: 'npm test', label: 'npm test', status: 'passed' },
            { key: 'npm run lint', label: 'npm run lint', status: 'pending' },
          ],
        },
      },
    };

    const result = adaptCombinedCheckpoint(input, {
      projectId: 'project-1',
      sessionId: 'session-1',
    });

    expect(isProjectCheckpointV3(result)).toBe(true);
    expect(result.migration?.sourceVersion).toBe(2);
    expect(result.execution.currentStepId).toBe('verify');
    expect(result.snapshotMeta.trigger).toBe('verification_started');
    expect(result.completion.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'acceptance:npm test',
        required: true,
        status: 'satisfied',
      }),
      expect.objectContaining({
        id: 'acceptance:npm run lint',
        required: true,
        status: 'pending',
      }),
    ]));
    const passed = result.completion.conditions.find(c => c.id === 'acceptance:npm test')!;
    expect(passed.evidenceRefs).toHaveLength(1);
    expect(result.completion.operationOutcomes.find(
      outcome => outcome.toolCallId === passed.evidenceRefs[0],
    )).toMatchObject({
      toolName: 'legacy:verification',
      status: 'completed',
      effect: 'observe',
      legacySynthetic: true,
    });
  });

  it('preserves safe runtime, graph, embedded, and unknown legacy extensions', () => {
    const input = {
      ...combined(),
      runtimeV2: {
        runtimeVersion: 2,
        verificationPending: true,
        acceptanceGate: {
          active: true,
          commands: [{ key: 'npm test', label: 'npm test', status: 'pending' }],
        },
        branchBudget: {
          fileEdits: { 'src/a.ts': 2 },
          commandRetries: {},
          errorRepeats: {},
          recoverTriggers: 1,
        },
        recoverySignals: [{ source: 'other', message: 'resume', at: 1, consumed: false }],
        recentTools: [],
        recentFailures: [],
      },
      taskGraph: { nodes: [{ id: 'a' }] },
      graphMetrics: { completed: 1 },
      extensions: { providerFuture: { enabled: true } },
      customLegacyField: { value: 42 },
    };

    const result = adaptLegacyCheckpoint(input);

    expect(result.execution.resumable?.branchBudget).toEqual(input.runtimeV2.branchBudget);
    expect(result.extensions.runtimeResilience).toMatchObject({
      runtimeVersion: 2,
      recoverySignals: input.runtimeV2.recoverySignals,
    });
    expect(result.extensions.runtimeResilience).not.toHaveProperty('verificationPending');
    expect(result.extensions.runtimeResilience).not.toHaveProperty('acceptanceGate');
    expect(result.extensions.taskGraph).toEqual(input.taskGraph);
    expect(result.extensions.graphMetrics).toEqual(input.graphMetrics);
    expect(result.extensions.providerFuture).toEqual({ enabled: true });
    expect(result.extensions.legacyUnknown).toEqual({
      customLegacyField: { value: 42 },
    });
  });

  it('maps a direct PersistedRuntimeV1 payload', () => {
    const result = adaptLegacyCheckpoint({
      version: 1,
      task: task('passed'),
      repo: repo(),
    }, { capturedAt: at });

    expect(result.extensions.legacySource).toMatchObject({ kind: 'persisted-runtime' });
    expect(result.execution.taskState.goal).toBe('ship adapter');
    expect(result.completion.operationOutcomes).toEqual([
      expect.objectContaining({ status: 'completed', effect: 'observe', legacySynthetic: true }),
    ]);
    const condition = result.completion.conditions.find(c => c.sourceRef === 'legacy:verification')!;
    expect(condition).toMatchObject({ required: false, status: 'satisfied' });
    expect(condition.evidenceRefs).toEqual([result.completion.operationOutcomes[0].toolCallId]);
  });

  it('maps the last PersistedRuntimeV1 payload embedded in session notes', () => {
    const oldPayload = JSON.stringify({ version: 1, task: task('failed'), repo: repo() });
    const latestPayload = JSON.stringify({ version: 1, task: task('passed'), repo: repo() });
    const notes = [
      '# Session',
      `\`\`\`icecoder-runtime\n${oldPayload}\n\`\`\``,
      `\`\`\`icecoder-runtime\n${latestPayload}\n\`\`\``,
    ].join('\n');
    const result = adaptLegacyCheckpoint(notes, { capturedAt: at });

    expect(result.extensions.legacySource).toMatchObject({ kind: 'session-notes' });
    expect(result.memory.sessionNotes).toBe(notes);
    expect(result.completion.operationOutcomes[0].status).toBe('completed');
  });

  it('maps an Intent archive using combined runtime and archived context', () => {
    const archive = {
      version: 1,
      messageId: 'message-1',
      sessionId: 'session-archive',
      createdAt: at,
      userMessageTime: 1,
      combinedCheckpoint: combined('failed', 'passed'),
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: 'D:/repo',
      workspaceFiles: {},
      trackedPaths: [],
      structuredMessages: [{ role: 'user', content: 'fix it' }],
      uiMessages: [],
      sessionNotesContent: '# notes',
    };
    const result = adaptLegacyCheckpoint(archive);

    expect(result.extensions.legacySource).toMatchObject({ kind: 'intent-archive' });
    expect(result.identity).toMatchObject({
      checkpointId: 'task-1',
      sessionId: 'session-archive',
    });
    expect(result.workspace.root).toBe('D:/repo');
    expect(result.conversation.messages).toEqual([{ role: 'user', content: 'fix it' }]);
    expect(result.memory.sessionNotes).toBe('# notes');
    expect(result.completion.operationOutcomes[0]).toMatchObject({
      status: 'failed',
      toolName: 'legacy:verification',
    });
  });

  it('uses receipt > acceptance > lifecycle > verification mirror for conflicts', () => {
    const input = {
      ...combined('failed', 'passed'),
      runtimeV2: {
        runtimeVersion: 2,
        verificationPending: false,
        lastTrigger: 'manual',
        v2UpdatedAt: at,
        acceptanceGate: {
          active: true,
          commands: [{ key: 'npm test', label: 'npm test', status: 'failed' }],
        },
      },
      completion: {
        operationOutcomes: [{
          toolCallId: 'real-receipt',
          toolName: 'run_command',
          status: 'completed',
          effect: 'observe',
          risk: 'low',
          disposition: 'executed',
          scope: 'command:npm-test',
          receipt: { exitCode: 0 },
          at: Date.parse(at) + 1,
        }],
      },
    };
    const result = adaptLegacyCheckpoint(input);
    const mirror = result.completion.conditions.find(c => c.sourceRef === 'legacy:verification')!;

    expect(mirror.status).toBe('satisfied');
    expect(mirror.evidenceRefs).toEqual(['real-receipt']);
    expect(result.completion.conditions).toContainEqual(expect.objectContaining({
      id: 'acceptance:npm test',
      required: true,
      status: 'failed',
    }));
    expect(result.completion.operationOutcomes.filter(o => o.scope.startsWith('legacy:verification')))
      .toHaveLength(0);
  });

  it('keeps verification-only pending optional while explicit acceptance pending is required', () => {
    const mirrorOnly = adaptLegacyCheckpoint({
      version: 1,
      task: task('required'),
      repo: repo(),
    }, { capturedAt: at });
    expect(mirrorOnly.completion.conditions).toEqual([
      expect.objectContaining({ required: false, status: 'pending' }),
    ]);
    expect(mirrorOnly.completion.operationOutcomes).toEqual([]);

    const explicit = adaptLegacyCheckpoint({
      ...combined('completed', 'passed'),
      runtimeV2: {
        runtimeVersion: 2,
        verificationPending: true,
        lastTrigger: 'manual',
        v2UpdatedAt: at,
        acceptanceGate: {
          active: true,
          commands: [{ key: 'npm test', label: 'npm test', status: 'pending' }],
        },
      },
    });
    expect(explicit.completion.conditions).toContainEqual(expect.objectContaining({
      id: 'acceptance:npm test',
      required: true,
      status: 'pending',
    }));
  });

  it('is deterministic and stable across object key order', () => {
    const first = adaptLegacyCheckpoint({
      version: 1,
      task: task('passed'),
      repo: repo(),
    }, { capturedAt: at });
    const second = adaptLegacyCheckpoint({
      repo: repo(),
      task: task('passed'),
      version: 1,
    }, { capturedAt: at });

    expect(second).toEqual(first);
  });

  it('conservatively degrades malformed fields and records migration warnings', () => {
    const result = adaptLegacyCheckpoint({
      version: 1,
      task: {
        goal: 42,
        intent: 'launch',
        phase: 'done',
        filesRead: ['ok.ts', 7],
        filesChanged: null,
        commandsRun: {},
        verificationRequired: true,
        verificationStatus: 'definitely',
      },
      repo: {
        filesRead: 'bad',
        filesChanged: [],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
    }, { capturedAt: at });

    expect(isProjectCheckpointV3(result)).toBe(true);
    expect(result.execution.taskState).toMatchObject({
      goal: '',
      intent: 'inspect',
      phase: 'context',
      filesRead: ['ok.ts'],
    });
    expect(result.execution.taskState).not.toHaveProperty('verificationRequired');
    expect(result.execution.taskState).not.toHaveProperty('verificationStatus');
    expect(result.completion.conditions).toEqual([
      expect.objectContaining({ required: false, status: 'pending' }),
    ]);
    expect(result.migration?.warnings.length).toBeGreaterThan(0);
  });

  it('keeps intent archives without combinedCheckpoint recoverable via structured messages', () => {
    const result = adaptLegacyCheckpoint({
      version: 1,
      messageId: 'message-plain',
      sessionId: 'session-plain',
      createdAt: at,
      projectCheckpoint: null,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: 'D:/repo',
      workspaceFiles: {},
      trackedPaths: [],
      structuredMessages: [{
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"src/a.ts"}',
        }],
      }],
      uiMessages: [{ role: 'user', content: 'open it', id: 'message-plain' }],
    });

    expect(isProjectCheckpointV3(result)).toBe(true);
    expect(result.extensions.legacySource).toMatchObject({ kind: 'intent-archive' });
    expect(result.conversation.messages[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } }],
    });
  });
});
