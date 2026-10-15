/**
 * 聊天 WebSocket 断线时的出站队列。
 * 只有还没离开浏览器的用户消息才入队；连接恢复后按原顺序发出。
 */

export const WS_OUTBOUND_QUEUE_LIMIT = 20;

export type SocketSendPlan = 'send' | 'queue' | 'drop';

export function planSocketSend(socketOpen: boolean, messageType: string): SocketSendPlan {
  if (socketOpen) return 'send';
  if (messageType === 'message') return 'queue';
  return 'drop';
}

/** 关连接时保留本地「正在跑」。重连后的 session_run_state 再纠正。 */
export function shouldResetProcessingOnSocketClose(): boolean {
  return false;
}

export function enqueueOutboundMessage<T>(queue: readonly T[], message: T, limit = WS_OUTBOUND_QUEUE_LIMIT): T[] {
  const next = queue.length >= limit ? queue.slice(queue.length - limit + 1) : queue.slice();
  next.push(message);
  return next;
}

export function flushOutboundMessages<T>(queue: readonly T[]): { pending: T[]; rest: T[] } {
  return { pending: queue.slice(), rest: [] };
}
