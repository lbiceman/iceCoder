/**
 * Harness 审计 P1（#40–#47）回归测试。见 docs/harness/Harness-审计修复清单.md。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMResponse, UnifiedMessage } from '../../src/llm/types.js';
import { HARD_COMPACTION_RATIO } from '../../src/harness/compaction-constants.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { Harness } from '../../src/harness/harness.js';
import { maybeCompact } from '../../src/harness/harness-compaction.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { ChatFunction } from '../../src/harness/types.js';
import {
  assertLongTermMemoryWriteCapAllowed,
  getOrCreateSessionLongTermMemoryWriteCap,
  registerLongTermMemoryWriteCap,
  resetSessionLongTermMemoryWriteCaps,
} from '../../src/memory/file-memory/memory-write-pipeline.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

const wsMocks = vi.hoisted(() => ({
  applyLock: vi.fn(),
  clearScope: vi.fn(),
}));

vi.mock('../../src/harness/session-workspace-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/harness/session-workspace-store.js')>();
  return { ...actual, applyUserMessageWorkspaceLock: wsMocks.applyLock };
});

vi.mock('../../src/tools/read-before-edit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/read-before-edit.js')>();
  return { ...actual, clearReadBeforeEditScope: wsMocks.clearScope };
});

const origContextWindow = process.env.ICE_CONTEXT_WINDOW;
const origConfigPath = process.env.ICE_CONFIG_PATH;
const tempDirs: string[] = [];

async function makeTempDir(prefix: string, base = os.tmpdir()): Promise<string> {
  const dir = await fs.mkdtemp(path.join(base, prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (origContextWindow === undefined) delete process.env.ICE_CONTEXT_WINDOW;
  else process.env.ICE_CONTEXT_WINDOW = origContextWindow;
  if (origConfigPath === undefined) delete process.env.ICE_CONFIG_PATH;
  else process.env.ICE_CONFIG_PATH = origConfigPath;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const finalResponse: LLMResponse = {
  content: 'done',
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'test' },
  finishReason: 'stop',
};

const LONG_TASK = `请按以下要求重构支付模块：${'拆分结算流程、补充幂等校验并更新对应单元测试。'.repeat(12)}`;

describe('#40 workspaceRoot 不跨 run 泄漏', () => {
  it('上一轮锁定的工作区不会延续到未锁定的下一轮', async () => {
    const sessionDir = await makeTempDir('icecoder-audit40-sess-');
    const defaultRoot = await makeTempDir('icecoder-audit40-default-');
    const lockedRoot = await makeTempDir(
      'icecoder-audit40-locked-',
      process.platform === 'win32' ? os.tmpdir() : os.homedir(),
    );

    wsMocks.clearScope.mockClear();
    wsMocks.applyLock
      .mockResolvedValueOnce({ state: { lockedRoot, referenceReads: [] }, detection: { changed: true } })
      .mockResolvedValueOnce({ state: { referenceReads: [] }, detection: { changed: false } });

    const harness = new Harness({
      context: { systemPrompt: 'test', tools: [] },
      loop: { maxRounds: 3 },
      compactionTokenThreshold: 999_999,
      memoryDisabled: true,
      memoryDir: '__test_nonexistent_memory_dir__',
      sessionDir,
      sessionId: 'audit-40',
      workspaceRoot: defaultRoot,
    }, new ToolExecutor(new ToolRegistry(), {
      maxRetries: 0,
      retryBaseDelay: 0,
      retryMaxDelay: 0,
      toolTimeout: 5000,
    }));
    const chatFn: ChatFunction = vi.fn(async () => finalResponse);

    await harness.run(`在 ${lockedRoot} 里看看`, chatFn);
    await harness.run('再看看', chatFn);

    expect(wsMocks.clearScope).toHaveBeenCalledTimes(2);
    expect(wsMocks.clearScope.mock.calls[0][0]).toBe(lockedRoot);
    expect(wsMocks.clearScope.mock.calls[1][0]).toBe(defaultRoot);
  });
});

describe('#41 记忆与压缩按当前上下文窗口动态计算', () => {
  it('硬压缩阈值随窗口变化，不在构造时冻结', () => {
    process.env.ICE_CONTEXT_WINDOW = '1000000';
    const compactor = new ContextCompactor();
    process.env.ICE_CONTEXT_WINDOW = '200000';

    const used = Math.floor(200_000 * HARD_COMPACTION_RATIO) + 2_000;
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'ok' }];
    expect(compactor.needsCompaction(messages, { lastApiPromptTokens: used })).toBe(true);
  });

  it('显式 tokenThreshold 仍优先', () => {
    process.env.ICE_CONTEXT_WINDOW = '200000';
    const compactor = new ContextCompactor({ tokenThreshold: 999_999 });
    const used = Math.floor(200_000 * HARD_COMPACTION_RATIO) + 2_000;
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'ok' }];
    expect(compactor.needsCompaction(messages, { lastApiPromptTokens: used })).toBe(false);
  });

  it('记忆预算读取与压缩器相同的生效窗口（默认 provider maxContextTokens）', async () => {
    delete process.env.ICE_CONTEXT_WINDOW;
    const dir = await makeTempDir('icecoder-audit41-cfg-');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      providers: [{
        id: 'big-window',
        apiUrl: 'http://localhost:8000/v1',
        apiKey: 'sk-test',
        modelName: 'gpt-4o',
        isDefault: true,
        maxContextTokens: 1_000_000,
      }],
    }), 'utf-8');
    process.env.ICE_CONFIG_PATH = configPath;

    const memory = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__', sessionId: 'audit-41' });
    try {
      expect((memory as unknown as { estimateContextWindow(): number }).estimateContextWindow()).toBe(1_000_000);
    } finally {
      memory.dispose();
    }
  });
});

describe('#42 空召回冷却遇话题切换即解除', () => {
  type CooldownInternals = {
    memoryDirExists: boolean | null;
    hasMemories: boolean | null;
    emptyRecallCooldown: number;
    lastInjectionUserMessage: string;
  };

  async function memoryInCooldown(previous: string): Promise<{
    memory: HarnessMemoryIntegration;
    internals: CooldownInternals;
  }> {
    const memoryDir = await makeTempDir('icecoder-audit42-mem-');
    const memory = new HarnessMemoryIntegration({ memoryDir, sessionId: 'audit-42' });
    const internals = memory as unknown as CooldownInternals;
    internals.memoryDirExists = true;
    internals.hasMemories = true;
    internals.emptyRecallCooldown = 3;
    internals.lastInjectionUserMessage = previous;
    return { memory, internals };
  }

  const previous = 'refactor database connection pool timeout retry logic and add unit tests';

  it('话题切换时清空冷却并重新召回', async () => {
    const { memory, internals } = await memoryInCooldown(previous);
    try {
      await memory.injectMemoryContext([
        { role: 'user', content: 'write README section describing kubernetes deployment pipeline stages' },
      ]);
      expect(internals.emptyRecallCooldown).toBe(0);
      expect(internals.lastInjectionUserMessage).toContain('kubernetes');
    } finally {
      memory.dispose();
    }
  });

  it('话题未变时照常消耗冷却', async () => {
    const { memory, internals } = await memoryInCooldown(previous);
    try {
      await memory.injectMemoryContext([{ role: 'user', content: previous }]);
      expect(internals.emptyRecallCooldown).toBe(2);
    } finally {
      memory.dispose();
    }
  });
});

describe('#43 dispose 不清掉其他会话注册的长期记忆配额', () => {
  afterEach(() => {
    registerLongTermMemoryWriteCap(null);
    resetSessionLongTermMemoryWriteCaps();
  });

  it('旧实例 dispose 后，后注册的会话配额仍生效', () => {
    resetSessionLongTermMemoryWriteCaps();
    const a = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__', sessionId: 'audit-43-a' });
    const b = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__', sessionId: 'audit-43-b' });
    getOrCreateSessionLongTermMemoryWriteCap('audit-43-b').writtenBasenames.add('first.md');

    a.dispose();
    expect(assertLongTermMemoryWriteCapAllowed('/mem/second.md')).toMatch(/session_memory_write_cap/);

    b.dispose();
    expect(assertLongTermMemoryWriteCapAllowed('/mem/second.md')).toBeNull();
  });
});

function compactorForSplit(keepRecent: number): ContextCompactor {
  return new ContextCompactor({
    threshold: 9999,
    keepRecent,
    keepRecentMinTokens: 1_000_000,
    keepRecentMaxTokens: 1_000_000,
    keepRecentMinMessages: 1,
    enableLLMSummary: false,
    maxReinjectFiles: 1,
    maxReinjectTokens: 0,
  });
}

type SplitResult = {
  systemMessages: UnifiedMessage[];
  droppedMessages: UnifiedMessage[];
  recentMessages: UnifiedMessage[];
};

function split(compactor: ContextCompactor, messages: UnifiedMessage[]): SplitResult {
  return (compactor as unknown as { splitMessages(m: UnifiedMessage[]): SplitResult }).splitMessages(messages);
}

describe('#44 splitMessages 文件工具集合与策略白名单一致', () => {
  it('batch_edit_file 交互对与相邻 read_file 一起保留，recent 不以孤立 tool 开头', () => {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b1', name: 'batch_edit_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'b1', content: 'edited a.ts' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'r1', content: 'const a = 1;' },
      { role: 'user', content: 'third' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'fourth' },
      { role: 'assistant', content: 'b' },
    ];

    const { recentMessages } = split(compactorForSplit(6), messages);

    expect(recentMessages[0]?.role).not.toBe('tool');
    expect(recentMessages.some(m => m.toolCalls?.some(tc => tc.id === 'b1'))).toBe(true);
    expect(recentMessages.some(m => m.role === 'tool' && m.toolCallId === 'b1')).toBe(true);
  });
});

describe('#45 长任务消息不再阻止自然压缩', () => {
  it('自然切分丢弃旧历史，并原样保留最近一条长任务消息', () => {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: LONG_TASK },
      { role: 'assistant', content: 'old answer 1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'old answer 2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'old answer 3' },
      { role: 'user', content: 'q4' },
      { role: 'assistant', content: 'a4' },
      { role: 'user', content: 'q5' },
      { role: 'assistant', content: 'a5' },
    ];
    const compactor = compactorForSplit(4);

    const parts = split(compactor, messages);
    expect(parts.droppedMessages.length).toBeGreaterThan(0);
    expect(parts.recentMessages[0]?.content).toBe(LONG_TASK);

    const result = compactor.compactWithSessionMemory(messages, '# notes');
    expect(result.some(m => typeof m.content === 'string' && m.content.startsWith('<context-summary>'))).toBe(true);
    expect(result.some(m => m.role === 'user' && m.content === LONG_TASK)).toBe(true);
    expect(result.some(m => m.content === 'old answer 1')).toBe(false);
  });

  it('强制切分（单一真实 user）时仍保留任务消息', () => {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: LONG_TASK },
    ];
    for (let i = 0; i < 4; i++) {
      messages.push(
        { role: 'assistant', content: '', toolCalls: [{ id: `g${i}`, name: 'grep', arguments: { pattern: `p${i}` } }] },
        { role: 'tool', toolCallId: `g${i}`, content: `match ${i}` },
      );
    }
    messages.push({ role: 'assistant', content: 'progress' });
    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 20,
      keepRecentMinTokens: 50,
      keepRecentMaxTokens: 100_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 1,
      maxReinjectTokens: 0,
    });

    const result = compactor.compactWithSessionMemory(messages, '# notes', { forceFullCompact: true });

    expect(result.some(m => typeof m.content === 'string' && m.content.startsWith('<context-summary>'))).toBe(true);
    expect(result.some(m => m.role === 'user' && m.content === LONG_TASK)).toBe(true);
    expect(result.some(m => m.role === 'tool' && m.toolCallId === 'g0')).toBe(false);
  });
});

describe('#46 硬压缩后最多补回 3 条最近记忆', () => {
  it('被压缩掉的最近 3 条记忆消息全部补回', async () => {
    const window = 200_000;
    process.env.ICE_CONTEXT_WINDOW = String(window);
    const memo = (n: number) => `<system-reminder>\nRecalled Memories #${n}\n- fact ${n}\n</system-reminder>`;
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'user', content: memo(1) },
      { role: 'assistant', content: 'ack 1' },
      { role: 'user', content: memo(2) },
      { role: 'assistant', content: 'ack 2' },
      { role: 'user', content: memo(3) },
      { role: 'assistant', content: 'ack 3' },
    ];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` });
    }

    const memoryIntegration = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__', sessionId: 'audit-46' });
    vi.spyOn(memoryIntegration, 'getSessionMemoryForCompact').mockResolvedValue('# notes');

    try {
      await maybeCompact({
        contextCompactor: new ContextCompactor({
          threshold: 9999,
          keepRecent: 4,
          keepRecentMinTokens: 50,
          keepRecentMaxTokens: 10_000,
          keepRecentMinMessages: 2,
          enableLLMSummary: false,
          maxReinjectFiles: 1,
          maxReinjectTokens: 0,
        }),
        memoryIntegration,
        checkpointEngine: undefined,
      } as never, {
        messages,
        chatFn: vi.fn(async () => finalResponse),
        logger: new HarnessLogger(),
        lastApiPromptTokens: Math.floor(window * HARD_COMPACTION_RATIO) + 5_000,
        tools: [],
      });
    } finally {
      memoryIntegration.dispose();
    }

    const recalled = messages
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .filter(c => c.startsWith('<system-reminder>') && c.includes('Recalled Memories'));
    expect(recalled).toEqual([memo(1), memo(2), memo(3)]);
  });
});

describe('#47 skipPermissionChecks 不跳过 deny 规则', () => {
  const logger = { toolCall: () => {}, toolResult: () => {} } as never;

  it('显式 deny 规则在 skip 模式下仍拦截', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'written' }));
    const onConfirm = vi.fn(async () => true);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [{ pattern: 'write_file', permission: 'deny', reason: 'read-only repo' }],
        skipPermissionChecks: true,
        onConfirm,
        workspaceRoot: process.cwd(),
        sessionId: 'audit-47-deny',
      },
      {
        toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } }],
        messages,
        logger,
      },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(String(messages.find(m => m.toolCallId === 'w1')?.content)).toMatch(/denied by policy: read-only repo/);
  });

  it('无显式规则时 skip 模式不因默认破坏性 confirm 而拦截', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'deleted' }));
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        skipPermissionChecks: true,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'audit-47-default',
      },
      {
        toolCalls: [{ id: 'd1', name: 'fs_operation', arguments: { operation: 'delete', path: 'tmp/old.log' } }],
        messages,
        logger,
      },
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
