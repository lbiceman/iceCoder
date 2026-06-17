/** 会话 ID 安全校验（防止路径穿越），sessions API 共用 */
export function isSafeSessionId(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') return false;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return false;
  return /^[\w-]+$/.test(sessionId);
}

export function rejectUnsafeSessionId(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  sessionId: string,
): boolean {
  if (isSafeSessionId(sessionId)) return false;
  res.status(400).json({ error: 'invalid session id' });
  return true;
}
