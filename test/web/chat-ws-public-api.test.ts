import { describe, expect, it } from 'vitest';
import {
  attachChatWebSocket,
  broadcastMcpReady,
  broadcastTunnelReady,
  cleanupChatResources,
  getActiveSessionId,
  getProcessingSessionIds,
  getSessionsDir,
  isSessionTombstoned,
  notifyTaskQueueUpdated,
  purgeSessionRuntimeCaches,
} from '../../src/web/chat-ws.js';

describe('chat-ws 公共入口运行时加载', () => {
  it('对外 API 均可导入且类型为函数', () => {
    expect(typeof attachChatWebSocket).toBe('function');
    expect(typeof cleanupChatResources).toBe('function');
    expect(typeof broadcastMcpReady).toBe('function');
    expect(typeof broadcastTunnelReady).toBe('function');
    expect(typeof getActiveSessionId).toBe('function');
    expect(typeof getProcessingSessionIds).toBe('function');
    expect(typeof getSessionsDir).toBe('function');
    expect(typeof isSessionTombstoned).toBe('function');
    expect(typeof notifyTaskQueueUpdated).toBe('function');
    expect(typeof purgeSessionRuntimeCaches).toBe('function');
    expect(typeof getActiveSessionId()).toBe('string');
    expect(Array.isArray(getProcessingSessionIds())).toBe(true);
  });
});
