/**
 * 删消息 / 回滚后作废尚未落地的会话笔记 / 计划写入。
 * 后台 LLM 更新笔记可达数十秒；完成后仍写入会把已丢掉的回合灌回模型上下文。
 */

const epochs = new Map<string, number>();

export function bumpSessionContextWriteEpoch(sessionId: string): number {
  const id = String(sessionId || '').trim();
  if (!id) return 0;
  const next = (epochs.get(id) ?? 0) + 1;
  epochs.set(id, next);
  return next;
}

export function sessionContextWriteEpoch(sessionId: string): number {
  const id = String(sessionId || '').trim();
  if (!id) return 0;
  return epochs.get(id) ?? 0;
}

export function isSessionContextWriteStale(sessionId: string, epoch: number): boolean {
  return epoch !== sessionContextWriteEpoch(sessionId);
}

/** 测试用 */
export function resetSessionContextWriteEpoch(sessionId?: string): void {
  if (sessionId) {
    epochs.delete(sessionId);
    return;
  }
  epochs.clear();
}
