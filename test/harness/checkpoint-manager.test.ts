import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskCheckpointManager } from '../../src/harness/checkpoint.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('TaskCheckpointManager · resume summary', () => {
  it('buildResumeMessage returns short summary without full checkpoint JSON', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-cp-mgr-'));
    const manager = new TaskCheckpointManager(sessionDir);

    const checkpoint = await manager.save({
      status: 'running',
      userGoal: 'Fix build',
      taskState: new TaskState('Fix survivors build with npm run build').snapshot(),
      repoContext: new RepoContext().snapshot(),
      loopState: {
        currentRound: 2,
        totalToolCalls: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        stopReason: undefined,
        executionMode: 'free',
      },
      messages: [{ role: 'user', content: 'Fix build' }] as UnifiedMessage[],
    });

    const resume = manager.buildResumeMessage(checkpoint);
    expect(resume.role).toBe('user');
    expect(resume.preserveOnCompaction).toBe(true);
    expect(typeof resume.content).toBe('string');
    expect(resume.content).toContain('<resume-checkpoint>');
    expect(resume.content).not.toContain('"version": 1');
    expect(resume.content.length).toBeLessThan(5000);
    expect((await manager.loadProject())?.completion.verificationState).toMatchObject({
      workspaceMutationVersion: 0,
      continuationCount: 0,
      commandProgress: [],
    });
  });

  it('save sanitizes nested resume-checkpoint blocks from task goal', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-cp-sanitize-'));
    const manager = new TaskCheckpointManager(sessionDir);
    const nested = `Original goal ${'x'.repeat(100)}<resume-checkpoint>old</resume-checkpoint>`;
    const taskState = new TaskState(nested);

    const saved = await manager.save({
      status: 'running',
      userGoal: 'Fix build',
      taskState: taskState.snapshot(),
      repoContext: new RepoContext().snapshot(),
      loopState: {
        currentRound: 1,
        totalToolCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        stopReason: undefined,
        executionMode: 'free',
      },
      messages: [{ role: 'user', content: nested }] as UnifiedMessage[],
    });

    expect(saved.taskState.goal).not.toContain('<resume-checkpoint>');
    expect(saved.taskState.goal).toContain('Original goal');
  });

  it('does not reactivate a D-prime completed checkpoint because of legacy conditions', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-cp-dprime-'));
    const manager = new TaskCheckpointManager(sessionDir);
    const taskState = new TaskState('实现功能');
    taskState.recordToolResult(
      { id: 'write', name: 'write_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'written' },
    );

    await manager.save({
      status: 'completed',
      userGoal: '实现功能',
      taskState: taskState.snapshot(),
      repoContext: new RepoContext().snapshot(),
      loopState: {
        currentRound: 2,
        totalToolCalls: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        lastInputTokens: 5,
        lastOutputTokens: 2,
        startTime: 1,
        stopReason: 'model_done',
      },
      messages: [{ role: 'user', content: '实现功能' }],
      completion: {
        conditions: [{
          id: 'legacy:acceptance',
          label: 'legacy pending condition',
          required: true,
          status: 'pending',
          source: 'user',
          sourceRef: 'legacy',
          evidenceRefs: [],
        }],
        operationOutcomes: [],
        status: 'completed_unverified',
        reason: 'verification_plan_unavailable',
        continuationCount: 0,
      },
    });

    expect(await manager.loadActive()).toBeNull();
  });
});
