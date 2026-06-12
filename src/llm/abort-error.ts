/**
 * 统一 abort 错误识别 — 让 LLMAdapter.withRetry / harness-llm-call 把用户中断与可重试错误区分开。
 *
 * provider SDK 在 fetch abort 时通常抛 `APIUserAbortError`、DOMException(name:'AbortError')
 * 或带 `code: 'ABORT_ERR'`/`name: 'AbortError'` 的普通 Error。这里统一兜底，对外暴露一个
 * 标记 `(err as any).isAbortError === true`，retry 与 stop 流程都按此判定。
 */

export const ABORT_ERROR_FLAG = 'isAbortError';

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const anyErr = error as any;
  if (anyErr[ABORT_ERROR_FLAG] === true) return true;
  if (anyErr.name === 'AbortError') return true;
  if (anyErr.code === 'ABORT_ERR') return true;
  // OpenAI SDK: APIUserAbortError 继承 APIError，message 包含 'aborted'
  const msg = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  if (msg.includes('request was aborted') || msg.includes('aborted by user')) return true;
  return false;
}

/**
 * 构造一个标记过 isAbortError 的错误，避免重试逻辑误判可重试。
 */
export function makeAbortedError(provider: string): Error {
  const err = new Error(`[${provider}] request aborted by user`);
  (err as any)[ABORT_ERROR_FLAG] = true;
  (err as any).name = 'AbortError';
  return err;
}
