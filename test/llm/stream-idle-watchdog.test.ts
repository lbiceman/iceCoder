import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStreamIdleWatchdog,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  isStreamIdleTimeoutError,
  resolveOpenAiStreamIdleTimeoutMs,
  streamIdleTimeoutError,
  withStreamIdleWatchdog,
} from '../../src/llm/stream-idle-watchdog.js';
import { isRetryableError } from '../../src/harness/harness-llm-log.js';

describe('resolveOpenAiStreamIdleTimeoutMs', () => {
  afterEach(() => {
    delete process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS;
  });

  it('defaults to 300s', () => {
    expect(resolveOpenAiStreamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  });

  it('reads and clamps ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS', () => {
    process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS = '90000';
    expect(resolveOpenAiStreamIdleTimeoutMs()).toBe(90_000);
    process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS = '5000';
    expect(resolveOpenAiStreamIdleTimeoutMs()).toBe(15_000);
    process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS = '999999';
    expect(resolveOpenAiStreamIdleTimeoutMs()).toBe(600_000);
  });

  it('ignores invalid env', () => {
    process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS = 'nope';
    expect(resolveOpenAiStreamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  });
});

describe('createStreamIdleWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts when no stream activity arrives', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const watchdog = createStreamIdleWatchdog({
      timeoutMs: 1_000,
      heartbeatMs: 200,
      log: (message) => logs.push(message),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchdog.didTimeout()).toBe(true);
    expect(watchdog.signal.aborted).toBe(true);
    expect(logs.some(line => line.includes('无响应'))).toBe(true);
    watchdog.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets idle time on every activity, then times out after activity stops', async () => {
    vi.useFakeTimers();
    const watchdog = createStreamIdleWatchdog({ timeoutMs: 1_000, heartbeatMs: 200 });
    watchdog.markActivity();
    await vi.advanceTimersByTimeAsync(800);
    expect(watchdog.didTimeout()).toBe(false);
    watchdog.markActivity();
    await vi.advanceTimersByTimeAsync(800);
    expect(watchdog.didTimeout()).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(watchdog.didTimeout()).toBe(true);
    watchdog.dispose();
  });

  it('does not log waiting while activity remains fresh', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const watchdog = createStreamIdleWatchdog({
      timeoutMs: 2_000,
      heartbeatMs: 200,
      log: (message) => logs.push(message),
    });
    watchdog.markActivity();
    await vi.advanceTimersByTimeAsync(150);
    expect(logs).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(logs.some(line => line.includes('无新响应'))).toBe(true);
    watchdog.dispose();
  });

  it('treats user abort as abort, not idle timeout', () => {
    vi.useFakeTimers();
    const user = new AbortController();
    const watchdog = createStreamIdleWatchdog({
      timeoutMs: 10_000,
      userSignal: user.signal,
    });
    user.abort();
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.didTimeout()).toBe(false);
    watchdog.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withStreamIdleWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS;
  });

  it('maps idle abort to a typed retryable timeout error', async () => {
    vi.useFakeTimers();
    process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS = '15000';
    const pending = withStreamIdleWatchdog(undefined, async (watchdog) => {
      await new Promise<void>((_, reject) => {
        watchdog.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const expectation = expect(pending).rejects.toSatisfy((error: unknown) =>
      isStreamIdleTimeoutError(error) && isRetryableError(error),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
  });

  it('does not remap user abort', async () => {
    const user = new AbortController();
    const pending = withStreamIdleWatchdog(user.signal, async (watchdog) => {
      await new Promise<void>((_, reject) => {
        watchdog.signal.addEventListener('abort', () => {
          const error = new Error('Request was aborted.');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    user.abort();
    await expectation;
  });

  it('creates a typed idle error', () => {
    const error = streamIdleTimeoutError(300_000);
    expect(isStreamIdleTimeoutError(error)).toBe(true);
    expect(error.message).toContain('300000ms');
  });
});
