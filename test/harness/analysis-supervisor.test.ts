import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AsyncSubAgentManager } from '../../src/harness/async-sub-agent-manager.js';
import { AnalysisSupervisor } from '../../src/harness/supervisor/analysis-supervisor.js';
import { EventTimeline } from '../../src/harness/supervisor/event-timeline.js';
import type { ChatFunction } from '../../src/harness/types.js';
import type { LLMResponse } from '../../src/llm/types.js';
import type { ToolExecutor } from '../../src/tools/tool-executor.js';

function makeResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      provider: 'test',
    },
    finishReason: 'stop',
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AnalysisSupervisor', () => {
  let sessionDir: string;
  const sessionId = 'sess-analysis-supervisor';
  const toolExecutor = {
    executeTool: vi.fn(),
  } as unknown as ToolExecutor;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-analysis-supervisor-'));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('records request/start/finish/ready events and exposes ready analyses', async () => {
    const finished = deferred();
    const chatFn: ChatFunction = vi.fn(async () => makeResponse('Explorer found src/auth.'));
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });
    const timeline = new EventTimeline({
      enabled: true,
      persistPath: 'unused.jsonl',
    }, { memoryOnly: true });
    const supervisor = new AnalysisSupervisor({
      sessionDir,
      manager,
      eventTimeline: timeline,
      mode: 'free',
    });
    manager.on('analysis_finished', () => finished.resolve());

    const result = supervisor.requestAnalysis({
      sessionId,
      kind: 'explorer',
      prompt: 'Explore auth',
      requestedAt: 100,
    }, { round: 3, reason: 'test_request' });

    expect(result.status).toBe('pending');

    await finished.promise;

    const events = timeline.getRecentEvents().map(event => event.event);
    expect(events).toEqual([
      'analysis_requested',
      'analysis_started',
      'analysis_finished',
      'workspace_analysis_updated',
      'analysis_ready',
    ]);

    const ready = await supervisor.getReadyAnalyses(sessionId);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.taskId).toBe(result.taskId);
    expect(ready[0]?.summaryPreview).toBe('Explorer found src/auth.');
  });

  it('auto trigger is enabled by default and suppresses duplicate run-level triggers', () => {
    const chatFn: ChatFunction = vi.fn(async () => makeResponse('unused'));
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });
    const supervisor = new AnalysisSupervisor({ sessionDir, manager });

    expect(supervisor.shouldAutoTrigger('explorer')).toBe(true);
    expect(supervisor.shouldAutoTrigger('explorer', { alreadyTriggered: true })).toBe(false);
  });
});
