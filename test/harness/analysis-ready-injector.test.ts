import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AsyncSubAgentManager } from '../../src/harness/async-sub-agent-manager.js';
import { takeAnalysisReadyForInjection } from '../../src/harness/analysis-ready-injector.js';
import { writeAnalysisArtifact, readAnalysisArtifactByTaskId } from '../../src/harness/analysis-workspace-store.js';
import { AnalysisSupervisor } from '../../src/harness/supervisor/analysis-supervisor.js';
import type { ChatFunction } from '../../src/harness/types.js';
import type { ToolExecutor } from '../../src/tools/tool-executor.js';

describe('analysis-ready-injector', () => {
  let sessionDir: string;
  const sessionId = 'sess-analysis-ready';
  const toolExecutor = { executeTool: vi.fn() } as unknown as ToolExecutor;
  const chatFn: ChatFunction = vi.fn() as unknown as ChatFunction;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-analysis-ready-'));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('injects ready analyses once and marks artifacts consumed', async () => {
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });
    const supervisor = new AnalysisSupervisor({ sessionDir, manager });
    await writeAnalysisArtifact(sessionDir, sessionId, {
      sessionId,
      taskId: 'task-ready',
      kind: 'explorer',
      summary: 'Auth lives in src/auth.',
      filesRead: ['src/auth/index.ts'],
      status: 'completed',
      createdAt: 100,
    });

    const block = await takeAnalysisReadyForInjection({ supervisor, sessionId });
    expect(block).toContain('[Analysis Ready]');
    expect(block).toContain('explorer task task-ready');
    expect(block).toContain('src/auth/index.ts');

    const consumed = await readAnalysisArtifactByTaskId(sessionDir, sessionId, 'task-ready');
    expect(consumed?.consumedAt).toBeTruthy();

    await expect(takeAnalysisReadyForInjection({ supervisor, sessionId })).resolves.toBeNull();
  });
});
