import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { handleChatMessage } from '../../src/web/chat-ws-turn.js';
import { subscribeWsToSession, clearBroadcastState } from '../../src/web/chat-ws-broadcast.js';
import { clearRunningTurn } from '../../src/web/chat-ws-running-turn.js';
import { getFileBrowserState } from '../../src/web/chat-ws-runtime.js';

vi.mock('../../src/web/chat-ws-bg-tasks.js', () => ({
  rebindBgTaskPusher: vi.fn(async () => {}),
}));

vi.mock('../../src/web/chat-ws-persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/chat-ws-persist.js')>();
  return {
    ...actual,
    loadAssembledPrompt: vi.fn(async () => ({
      systemPromptSections: [],
      systemPrompt: 'test',
    })),
    ensureMemoryInitialized: vi.fn(async () => {}),
    appendMessages: vi.fn(async () => true),
    saveStructuredMessages: vi.fn(),
    broadcastHarnessState: vi.fn(),
    getPriorTrackedPaths: vi.fn(async () => []),
    getGlobalFileMemoryManager: vi.fn(() => null),
  };
});

vi.mock('../../src/web/images-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/images-cache.js')>();
  return {
    ...actual,
    persistInlineImages: vi.fn(async () => []),
    persistUploadedImageFiles: vi.fn(async () => []),
  };
});

vi.mock('../../src/web/routes/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/routes/config.js')>();
  return {
    ...actual,
    resolveDefaultSupportsVision: vi.fn(async () => false),
    resolveDefaultChatModelMeta: vi.fn(async () => null),
  };
});

vi.mock('../../src/session/shell-collab-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/session/shell-collab-store.js')>();
  return {
    ...actual,
    resolveShellCollabActive: vi.fn(async () => false),
  };
});

vi.mock('../../src/web/session-title.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/session-title.js')>();
  return {
    ...actual,
    applyFirstPromptSessionTitle: vi.fn(async () => null),
  };
});

vi.mock('../../src/web/file-browser-direct.js', () => ({
  detectFileBrowserOpen: () => true,
  looksLikeFileAnalysisIntent: () => false,
  tryDirectFileBrowserTurn: vi.fn(async () => ({
    handled: true,
    variant: 'deterministic',
    toolName: 'list_drives',
    toolDetail: '',
    assistantMarkdown: 'C:\\\nD:\\',
    success: true,
    newLastBrowsedPath: null,
  })),
}));

vi.mock('../../src/harness/harness.js', () => ({
  Harness: class {
    constructor() {
      throw new Error('Harness should not be constructed on deterministic file-browser turn');
    }
  },
}));

function fakeWs() {
  const sent: unknown[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    sent,
    send(body: string) {
      sent.push(JSON.parse(body));
    },
  };
  return ws as unknown as WebSocket & { sent: unknown[] };
}

const SID = `turn-direct-${Date.now()}`;

afterEach(() => {
  clearBroadcastState();
  clearRunningTurn(SID);
  const fbs = getFileBrowserState(SID);
  fbs.active = false;
  fbs.lastBrowsedPath = null;
});

describe('chat-ws-turn file-browser 旁路', () => {
  it('deterministic 目录列举不构造 Harness，并推送 stream_end/response', async () => {
    const ws = fakeWs();
    subscribeWsToSession(ws, SID);
    const stop = await handleChatMessage({
      ws,
      message: '~open',
      runSessionId: SID,
      orchestrator: { getLLMAdapter: () => ({}) } as never,
      toolRegistry: { getDefinitions: () => [] } as never,
      toolExecutor: {} as never,
    });
    expect(stop).toBe('model_done');
    const types = ws.sent.map((m) => (m as { type?: string }).type);
    expect(types).toContain('stream_end');
    expect(types).toContain('response');
    expect(types).toContain('tokenUsage');
    expect(ws.sent.some((m) =>
      (m as { type?: string }).type === 'step'
      && (m as { step?: { type?: string } }).step?.type === 'tool_call',
    )).toBe(true);
    expect(getFileBrowserState(SID).active).toBe(true);
  });
});
