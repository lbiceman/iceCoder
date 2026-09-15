/**
 * Stream 空闲检测：从请求发出起，或从上一个 SSE chunk 起，
 * 连续一段时间没有活动就中止。用户中断与空闲超时严格分开。
 */

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const STREAM_IDLE_HEARTBEAT_MS = 15_000;
export const STREAM_IDLE_TIMEOUT_CODE = 'STREAM_IDLE_TIMEOUT';

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Stream 两次活动之间的最长空闲时间。 */
export function resolveOpenAiStreamIdleTimeoutMs(): number {
  const raw = process.env.ICE_OPENAI_STREAM_IDLE_TIMEOUT_MS?.trim();
  let timeout = DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) timeout = n;
  }
  return clamp(timeout, 15_000, 600_000);
}

export function streamIdleTimeoutError(timeoutMs: number): Error {
  const error = new Error(`request timeout: no stream activity within ${timeoutMs}ms`);
  (error as NodeJS.ErrnoException).code = STREAM_IDLE_TIMEOUT_CODE;
  return error;
}

export function isStreamIdleTimeoutError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && (error as NodeJS.ErrnoException).code === STREAM_IDLE_TIMEOUT_CODE;
}

export interface StreamIdleWatchdog {
  signal: AbortSignal;
  markActivity: () => void;
  dispose: () => void;
  didTimeout: () => boolean;
}

/** 执行 stream；空闲超时抛可重试错误，用户中断保持原错误。 */
export async function withStreamIdleWatchdog<T>(
  userSignal: AbortSignal | undefined,
  run: (watchdog: StreamIdleWatchdog) => Promise<T>,
): Promise<T> {
  const timeoutMs = resolveOpenAiStreamIdleTimeoutMs();
  const watchdog = createStreamIdleWatchdog({
    timeoutMs,
    userSignal,
    log: (message) => console.log(message),
  });
  try {
    return await run(watchdog);
  } catch (error) {
    if (watchdog.didTimeout()) throw streamIdleTimeoutError(timeoutMs);
    throw error;
  } finally {
    watchdog.dispose();
  }
}

export function createStreamIdleWatchdog(opts: {
  timeoutMs: number;
  userSignal?: AbortSignal;
  log?: (message: string) => void;
  now?: () => number;
  heartbeatMs?: number;
}): StreamIdleWatchdog {
  const controller = new AbortController();
  const now = opts.now ?? Date.now;
  const userSignal = opts.userSignal;
  let lastActivityAt = now();
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const onUserAbort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  userSignal?.addEventListener('abort', onUserAbort, { once: true });

  const onIdleTimeout = (): void => {
    if (timedOut || userSignal?.aborted) return;
    timedOut = true;
    opts.log?.(`[OpenAI] stream 连续 ${opts.timeoutMs}ms 无响应，中止本次请求`);
    if (!controller.signal.aborted) controller.abort();
  };

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdleTimeout, opts.timeoutMs);
    unrefTimer(idleTimer);
  };
  armIdleTimer();

  const heartbeatMs = opts.heartbeatMs ?? STREAM_IDLE_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    if (timedOut || userSignal?.aborted) return;
    const idleMs = now() - lastActivityAt;
    if (idleMs < heartbeatMs) return;
    opts.log?.(`[OpenAI] stream 已 ${idleMs}ms 无新响应`);
  }, heartbeatMs);
  unrefTimer(heartbeat);

  const signal = userSignal
    ? AbortSignal.any([userSignal, controller.signal])
    : controller.signal;

  return {
    signal,
    markActivity() {
      if (timedOut || userSignal?.aborted) return;
      lastActivityAt = now();
      armIdleTimer();
    },
    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(heartbeat);
      userSignal?.removeEventListener('abort', onUserAbort);
    },
    didTimeout() {
      return timedOut && !userSignal?.aborted;
    },
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer.unref === 'function') timer.unref();
}
