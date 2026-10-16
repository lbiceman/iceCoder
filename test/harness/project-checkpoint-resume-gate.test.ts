import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompletionFactsView } from '../../src/harness/completion-facts-view.js';
import { OperationOutcomeLedger } from '../../src/harness/operation-outcome.js';
import { ProjectCheckpointStore } from '../../src/harness/project-checkpoint-store.js';
import { CheckpointEngine } from '../../src/harness/checkpoint-engine.js';
import type { ProjectCheckpointV3 } from '../../src/types/runtime-checkpoint.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-checkpoint-resume-gate-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function checkpoint(): ProjectCheckpointV3 {
  return {
    version: 3,
    identity: {
      checkpointId: 'run-1',
      projectId: 'project-1',
      sessionId: 'session-1',
    },
    execution: {
      taskState: {
        goal: 'Ship the patch after acceptance passes',
        intent: 'edit',
        phase: 'verification',
        filesRead: [],
        filesChanged: ['src/a.ts'],
        commandsRun: ['npm test'],
      },
      loopState: {
        currentRound: 3,
        totalInputTokens: 40,
        totalOutputTokens: 12,
        lastInputTokens: 20,
        lastOutputTokens: 4,
        totalToolCalls: 2,
        startTime: 1,
      },
      resumable: {
        failedToolCallSignatures: { 'run_command:npm test': 1 },
      },
    },
    completion: {
      conditions: [{
        id: 'user:npm-test',
        label: 'npm test must pass',
        required: true,
        status: 'failed',
        source: 'user',
        sourceRef: 'user:1',
        evidenceRefs: ['tool-test-1'],
      }],
      operationOutcomes: [{
        toolCallId: 'tool-test-1',
        toolName: 'run_command',
        status: 'failed',
        effect: 'execute',
        risk: 'low',
        disposition: 'execution_fail',
        scope: 'target:npm test',
        error: 'exit 1',
        at: 2,
        reversibility: 'compensatable',
      }],
      status: 'failed',
      reason: 'verification_failed',
      continuationCount: 1,
      blockingSignature: 'stop-verification:failed:npm test:1',
    },
    conversation: { messages: [{ role: 'user', content: 'Ship the patch after acceptance passes' }] },
    workspace: {
      root: tempDir,
      repoContext: {
        filesRead: [],
        filesChanged: ['src/a.ts'],
        commandsRun: ['npm test'],
        testCommands: ['npm test'],
        recentDiagnostics: ['npm test failed'],
      },
    },
    memory: {},
    snapshotMeta: {
      capturedAt: '2026-09-09T00:00:00.000Z',
      trigger: 'verification_failed',
    },
    extensions: {},
    migration: null,
  };
}

describe('V3 crash resume gate equivalence', () => {
  it('restores completion facts, blocking signature, and failed signatures from a saved V3 file', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    await store.save(checkpoint());

    const restored = await new ProjectCheckpointStore({
      sessionDir: tempDir,
      sessionId: 'session-1',
    }).load();
    expect(restored).not.toBeNull();

    const facts = CompletionFactsView.fromCompletionSnapshot(restored!.completion);
    const ledger = new OperationOutcomeLedger();
    ledger.replace(restored!.completion.operationOutcomes);

    expect(facts.conditionSnapshot()).toEqual(checkpoint().completion.conditions);
    expect(ledger.snapshot()).toEqual(checkpoint().completion.operationOutcomes);
    expect(restored!.completion.continuationCount).toBe(checkpoint().completion.continuationCount);
    expect(restored!.completion.blockingSignature).toBe(checkpoint().completion.blockingSignature);
    expect(restored!.completion.status).toBe('failed');
    expect(restored!.completion.reason).toBe('verification_failed');
    expect(restored!.execution.resumable?.failedToolCallSignatures).toEqual({ 'run_command:npm test': 1 });
  });

  it('still opens an old V3 file that carries write counts and execution-mode state', async () => {
    const legacy = checkpoint() as ProjectCheckpointV3 & Record<string, unknown>;
    (legacy.execution.resumable as Record<string, unknown>).branchBudget = {
      fileEdits: { 'src/a.ts': 2 },
      commandRetries: { 'npm test': 1 },
      errorRepeats: {},
      recoverTriggers: 0,
    };
    (legacy.execution.loopState as unknown as Record<string, unknown>).executionMode = 'forced';
    legacy.extensions.runtimeResilience = {
      runtimeVersion: 2,
      branchBudget: { fileEdits: { 'src/a.ts': 2 }, commandRetries: {}, errorRepeats: {}, recoverTriggers: 1 },
      recoverySignals: [{ source: 'branch_budget', message: 'switch', at: 1, consumed: false }],
      executionModeState: { executionMode: 'forced', executionModeEnteredBy: ['tool_failure'] },
      recentTools: [],
      recentFailures: [],
      lastTrigger: 'tool_failed',
      v2UpdatedAt: '2026-09-09T00:00:00.000Z',
    };
    await fs.writeFile(
      path.join(tempDir, 'session-1.checkpoint.json'),
      JSON.stringify(legacy),
      'utf-8',
    );

    const restored = await new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' }).load();
    expect(restored?.completion.blockingSignature).toBe(checkpoint().completion.blockingSignature);

    const engine = new CheckpointEngine(tempDir, 'session-1');
    const v2 = await engine.loadV2();
    expect(v2).not.toBeNull();
    expect(v2).not.toHaveProperty('branchBudget');
    expect(v2).not.toHaveProperty('executionModeState');
    expect(v2).not.toHaveProperty('recoverySignals');
  });

  it('does not persist while a tool batch lock is active', async () => {
    const engine = new CheckpointEngine(tempDir, 'session-1');
    engine.setToolExecutionLock(true);
    await engine.save({ trigger: 'step_completed' });
    await expect(fs.access(engine.checkpointPath)).rejects.toMatchObject({ code: 'ENOENT' });
    engine.setToolExecutionLock(false);
    await engine.save({ trigger: 'final_draft' });
    expect(JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8')).version).toBe(3);
  });
});
