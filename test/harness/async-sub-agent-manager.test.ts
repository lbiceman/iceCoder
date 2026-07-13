import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AsyncSubAgentManager } from '../../src/harness/async-sub-agent-manager.js';
import { readAnalysisArtifactByTaskId, readAsyncSubAgentTask } from '../../src/harness/analysis-workspace-store.js';
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

describe('AsyncSubAgentManager', () => {
  let sessionDir: string;
  const sessionId = 'sess-async-manager';
  const toolExecutor = {
    executeTool: vi.fn(),
  } as unknown as ToolExecutor;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-async-manager-'));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('submits immediately and writes a completed artifact in the background', async () => {
    const finished = deferred();
    const chatFn: ChatFunction = vi.fn(async () => makeResponse('Auth summary from explorer.'));
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });
    manager.on('analysis_finished', () => finished.resolve());

    const result = manager.submit({
      sessionId,
      kind: 'explorer',
      prompt: 'Explore auth module',
      requestedAt: 100,
    });

    expect(result.status).toBe('pending');
    expect(result.submitted).toBe(true);

    await finished.promise;
    const status = manager.getTaskStatus(result.taskId);
    const task = await readAsyncSubAgentTask(sessionDir, sessionId, result.taskId);
    const artifact = await readAnalysisArtifactByTaskId(sessionDir, sessionId, result.taskId);

    expect(status?.status).toBe('completed');
    expect(task?.artifactPath).toBe(artifact?.relativePath);
    expect(artifact?.summary).toBe('Auth summary from explorer.');
  });

  it('respects the max concurrency queue', async () => {
    const releaseFirst = deferred<LLMResponse>();
    const secondFinished = deferred();
    let calls = 0;
    const chatFn: ChatFunction = vi.fn(async () => {
      calls++;
      if (calls === 1) return releaseFirst.promise;
      return makeResponse('second summary');
    });
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });

    const first = manager.submit({ sessionId, kind: 'search', prompt: 'first' });
    const second = manager.submit({ sessionId, kind: 'search', prompt: 'second' });
    manager.on('analysis_finished', payload => {
      if (payload.taskId === second.taskId) secondFinished.resolve();
    });

    await delay(10);
    expect(manager.getTaskStatus(first.taskId)?.status).toBe('running');
    expect(manager.getTaskStatus(second.taskId)?.status).toBe('pending');
    expect(manager.listRunningTasks(sessionId)).toHaveLength(1);

    releaseFirst.resolve(makeResponse('first summary'));
    await secondFinished.promise;

    expect(manager.getTaskStatus(first.taskId)?.status).toBe('completed');
    expect(manager.getTaskStatus(second.taskId)?.status).toBe('completed');
  });

  it('can cancel a pending task before it starts', async () => {
    const releaseFirst = deferred<LLMResponse>();
    const chatFn: ChatFunction = vi.fn(() => releaseFirst.promise);
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });

    manager.submit({ sessionId, kind: 'review', prompt: 'running' });
    const pending = manager.submit({ sessionId, kind: 'review', prompt: 'pending' });

    await delay(10);
    expect(manager.cancel(pending.taskId, 'not needed')).toBe(true);
    expect(manager.getTaskStatus(pending.taskId)?.status).toBe('cancelled');

    releaseFirst.resolve(makeResponse('done'));
  });

  it('dedupes equivalent pending or running tasks', async () => {
    const releaseFirst = deferred<LLMResponse>();
    const chatFn: ChatFunction = vi.fn(() => releaseFirst.promise);
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });

    const first = manager.submit({
      sessionId,
      kind: 'explorer',
      prompt: 'Explore auth',
      scope: { scopeHash: 'auth' },
    });
    const second = manager.submit({
      sessionId,
      kind: 'explorer',
      prompt: 'Explore auth again',
      scope: { scopeHash: 'auth' },
    });

    expect(second.submitted).toBe(false);
    expect(second.taskId).toBe(first.taskId);

    releaseFirst.resolve(makeResponse('done'));
  });

  it('submits batches through submitBatch', () => {
    const chatFn: ChatFunction = vi.fn(async () => makeResponse('done'));
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });

    const results = manager.submitBatch([
      { sessionId, kind: 'explorer', prompt: 'one' },
      { sessionId, kind: 'search', prompt: 'two' },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every(result => result.submitted)).toBe(true);
  });

  it('marks rejected sub-agent runs as failed', async () => {
    const finished = deferred();
    const chatFn: ChatFunction = vi.fn(async () => {
      throw new Error('model failed');
    });
    const manager = new AsyncSubAgentManager({
      sessionDir,
      toolExecutor,
      toolDefinitions: [],
      chatFn,
      maxConcurrent: 1,
    });
    manager.on('analysis_finished', () => finished.resolve());

    const result = manager.submit({ sessionId, kind: 'dependency', prompt: 'deps' });
    await finished.promise;

    const status = manager.getTaskStatus(result.taskId);
    expect(status?.status).toBe('failed');
    expect(status?.error).toBe('model failed');
  });
});
