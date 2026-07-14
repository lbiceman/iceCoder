import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureAnalysisWorkspace,
  listAnalysisArtifacts,
  listPendingAnalysisTasks,
  markArtifactConsumed,
  readAnalysisArtifact,
  readAnalysisArtifactByTaskId,
  writeAnalysisArtifact,
  writeAsyncSubAgentTask,
} from '../../src/harness/analysis-workspace-store.js';
import { ASYNC_SUB_AGENT_SCHEMA_VERSION, type AsyncSubAgentTask } from '../../src/types/async-sub-agent.js';

describe('analysis-workspace-store', () => {
  let sessionDir: string;
  const sessionId = 'sess-analysis-store';

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-analysis-store-'));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  });

  it('creates the session-scoped analysis workspace directories', async () => {
    const paths = await ensureAnalysisWorkspace(sessionDir, sessionId);

    await expect(fs.stat(paths.analysisDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(paths.subtasksDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(paths.artifactsDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('writes, reads, lists, and marks an analysis artifact as consumed', async () => {
    const artifact = await writeAnalysisArtifact(sessionDir, sessionId, {
      sessionId,
      taskId: 'task-auth',
      kind: 'explorer',
      summary: 'Auth lives in src/auth and middleware.',
      filesRead: ['src/auth/index.ts'],
      status: 'completed',
      createdAt: 100,
    });

    expect(artifact.relativePath).toMatch(/^analysis\/explorer-task-auth-[a-f0-9]+\.md$/);

    const byPath = await readAnalysisArtifact(sessionDir, sessionId, artifact.relativePath);
    const byTask = await readAnalysisArtifactByTaskId(sessionDir, sessionId, 'task-auth');
    const listed = await listAnalysisArtifacts(sessionDir, sessionId);

    expect(byPath?.summary).toBe('Auth lives in src/auth and middleware.');
    expect(byTask?.id).toBe(artifact.id);
    expect(listed.map(row => row.taskId)).toEqual(['task-auth']);

    const consumed = await markArtifactConsumed(sessionDir, sessionId, 'task-auth', 200);
    expect(consumed?.consumedAt).toBe(200);
    expect((await readAnalysisArtifactByTaskId(sessionDir, sessionId, 'task-auth'))?.consumedAt).toBe(200);
  });

  it('lists pending and running tasks from the subtasks directory', async () => {
    const base: AsyncSubAgentTask = {
      version: ASYNC_SUB_AGENT_SCHEMA_VERSION,
      taskId: 'task-1',
      sessionId,
      kind: 'search',
      prompt: 'Find auth references',
      status: 'pending',
      filesRead: [],
      createdAt: 100,
    };

    await writeAsyncSubAgentTask(sessionDir, sessionId, base);
    await writeAsyncSubAgentTask(sessionDir, sessionId, {
      ...base,
      taskId: 'task-2',
      status: 'running',
      createdAt: 50,
    });
    await writeAsyncSubAgentTask(sessionDir, sessionId, {
      ...base,
      taskId: 'task-3',
      status: 'completed',
      createdAt: 1,
    });

    const pending = await listPendingAnalysisTasks(sessionDir, sessionId);
    expect(pending.map(task => task.taskId)).toEqual(['task-2', 'task-1']);
  });

  it('generates distinct artifact paths for concurrent writes', async () => {
    const rows = await Promise.all([
      writeAnalysisArtifact(sessionDir, sessionId, {
        sessionId,
        taskId: 'task-a',
        kind: 'search',
        summary: 'first',
        filesRead: [],
        status: 'completed',
      }),
      writeAnalysisArtifact(sessionDir, sessionId, {
        sessionId,
        taskId: 'task-b',
        kind: 'search',
        summary: 'second',
        filesRead: [],
        status: 'completed',
      }),
    ]);

    expect(new Set(rows.map(row => row.relativePath)).size).toBe(2);
    expect(await listAnalysisArtifacts(sessionDir, sessionId)).toHaveLength(2);
  });

  it('rejects paths that escape the session analysis workspace', async () => {
    await expect(writeAnalysisArtifact(sessionDir, sessionId, {
      sessionId,
      taskId: 'task-bad',
      kind: 'review',
      summary: 'bad',
      filesRead: [],
      status: 'completed',
      relativePath: '../escape.md',
    })).rejects.toThrow(/inside the analysis workspace/);
  });
});
