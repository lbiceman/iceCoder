import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HARD_COMPACTION_RATIO } from '../../src/harness/compaction-constants.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { maybeCompact } from '../../src/harness/harness-compaction.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { ChatFunction } from '../../src/harness/types.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

const CONTEXT_WINDOW = 200_000;

function filler(count: number): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [{ role: 'system', content: 'system prompt' }];
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `user ${i}: ${'x'.repeat(300)}` },
      { role: 'assistant', content: `assistant ${i}: ${'y'.repeat(300)}` },
    );
  }
  return msgs;
}

const chatFn: ChatFunction = async () => ({
  content: 'summary ok',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
  finishReason: 'stop',
});

function buildDeps(memoryIntegration: HarnessMemoryIntegration) {
  return {
    loopController: new LoopController({ maxRounds: 5 }),
    memoryIntegration,
    graphExecutor: undefined,
    contextCompactor: new ContextCompactor({
      threshold: 9999,
      keepRecent: 4,
      keepRecentMinTokens: 50,
      keepRecentMaxTokens: 10_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
      maxToolResultLength: 200,
    }),
    stopHookManager: { run: async () => ({ action: 'continue' }) } as never,
    checkpointManager: undefined,
    enqueueCheckpointPersist: async (task: () => Promise<unknown>) => task(),
    resilienceV2Enabled: false,
    checkpointEngine: undefined,
    toolExecutor: new ToolExecutor(new ToolRegistry(), {
      maxRetries: 0,
      retryBaseDelay: 0,
      retryMaxDelay: 0,
      toolTimeout: 5000,
    }),
    permissionRules: [],
    workspaceRoot: process.cwd(),
    executionModeDecisionEnabled: false,
    abortSignal: undefined,
  };
}

describe('maybeCompact · API 双轨硬压缩', () => {
  const origWindow = process.env.ICE_CONTEXT_WINDOW;

  beforeEach(() => {
    process.env.ICE_CONTEXT_WINDOW = String(CONTEXT_WINDOW);
  });

  afterEach(() => {
    if (origWindow === undefined) delete process.env.ICE_CONTEXT_WINDOW;
    else process.env.ICE_CONTEXT_WINDOW = origWindow;
    vi.restoreAllMocks();
  });

  it('API prompt 超硬压缩线、本地估算偏低时仍执行硬压缩（会话记忆路径）', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'short task description' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'done chunk' },
    ];
    const beforeLen = messages.length;
    const apiPrompt = Math.floor(CONTEXT_WINDOW * HARD_COMPACTION_RATIO) + 5_000;

    const memoryIntegration = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' });
    vi.spyOn(memoryIntegration, 'getSessionMemoryForCompact').mockResolvedValue('# session notes\n- task state');
    vi.spyOn(memoryIntegration, 'maybeUpdateSessionMemory').mockResolvedValue(undefined);

    const compactionEvents: string[] = [];
    await maybeCompact(buildDeps(memoryIntegration), {
      messages,
      chatFn,
      logger: new HarnessLogger(),
      lastApiPromptTokens: apiPrompt,
      tools: [],
      onStep: event => {
        if (event.type === 'compaction') compactionEvents.push(event.content ?? '');
      },
    });

    expect(compactionEvents.some(c => c.includes('→'))).toBe(true);
    expect(messages.some(m => typeof m.content === 'string' && m.content.includes('<context-summary>'))).toBe(true);
    expect(messages.length).toBeLessThan(beforeLen + 6);
  });

  it('API prompt 超线且消息量大时走 compact() 全层压缩', async () => {
    const messages = filler(60);
    const beforeLen = messages.length;
    const apiPrompt = Math.floor(CONTEXT_WINDOW * HARD_COMPACTION_RATIO) + 10_000;

    const memoryIntegration = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' });
    vi.spyOn(memoryIntegration, 'getSessionMemoryForCompact').mockResolvedValue('');
    vi.spyOn(memoryIntegration, 'maybeUpdateSessionMemory').mockResolvedValue(undefined);

    const compactSpy = vi.spyOn(ContextCompactor.prototype, 'compact');

    await maybeCompact(buildDeps(memoryIntegration), {
      messages,
      chatFn,
      logger: new HarnessLogger(),
      lastApiPromptTokens: apiPrompt,
      tools: [],
    });

    expect(compactSpy).toHaveBeenCalledOnce();
    const runOptions = compactSpy.mock.calls[0][3];
    expect(runOptions?.forceFullCompact).toBe(true);
    expect(messages.length).toBeLessThan(beforeLen);
    expect(messages.some(m => typeof m.content === 'string' && m.content.includes('<context-summary>'))).toBe(true);
  });

  it('微压缩节省不足时同轮升档硬压缩', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ];
    const apiPrompt = Math.floor(CONTEXT_WINDOW * 0.72) + 2_000;

    const memoryIntegration = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' });
    vi.spyOn(memoryIntegration, 'getSessionMemoryForCompact').mockResolvedValue('# notes');
    vi.spyOn(memoryIntegration, 'maybeUpdateSessionMemory').mockResolvedValue(undefined);

    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 4,
      keepRecentMinTokens: 50,
      keepRecentMaxTokens: 10_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
    });
    const lightSpy = vi.spyOn(compactor, 'doLightCompact').mockImplementation(msgs => msgs.slice());
    const sessionSpy = vi.spyOn(compactor, 'compactWithSessionMemory');

    const deps = buildDeps(memoryIntegration);
    deps.contextCompactor = compactor;

    await maybeCompact(deps, {
      messages,
      chatFn,
      logger: new HarnessLogger(),
      lastApiPromptTokens: apiPrompt,
      tools: [],
    });

    expect(lightSpy).toHaveBeenCalled();
    expect(sessionSpy).toHaveBeenCalled();
    expect(sessionSpy.mock.calls[0][2]?.forceFullCompact).toBe(true);
  });
});

describe('ContextCompactor · forceFullCompact', () => {
  it('forceFullCompact 在 split 无自然丢弃时仍产出 context-summary', () => {
    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 20,
      keepRecentMinTokens: 50,
      keepRecentMaxTokens: 100_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
    });
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
      { role: 'assistant', content: 'f' },
    ];

    const result = compactor.compactWithSessionMemory(messages, 'notes body', {
      forceFullCompact: true,
    });

    expect(result.some(m => typeof m.content === 'string' && m.content.includes('<context-summary>'))).toBe(true);
    expect(result.length).toBeLessThan(messages.length + 4);
  });
});
