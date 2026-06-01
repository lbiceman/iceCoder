/** 会话 ID 安全校验（防止路径穿越），sessions API 共用 */
export function isSafeSessionId(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') return false;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return false;
  return /^[\w-]+$/.test(sessionId);
}
