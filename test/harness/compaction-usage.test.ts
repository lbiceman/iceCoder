import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import {
  HARD_COMPACTION_RATIO,
  MICRO_COMPACTION_RATIO,
} from '../../src/harness/compaction-constants.js';
import { buildTotalTokenUsageWithContext } from '../../src/harness/context-usage-display.js';
import {
  estimateToolsTokens,
  resolveCompactionUsage,
} from '../../src/llm/token-estimator.js';
import type { ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';

const CONTEXT_WINDOW = 200_000;

describe('resolveCompactionUsage', () => {
  it('effectiveUsed 取本地估算+tools 与 API prompt 的较大值', () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'hello' }];
    const tools: ToolDefinition[] = [
      { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    ];
    const local = resolveCompactionUsage({ messages, tools, lastApiPromptTokens: 0 });
    const withApi = resolveCompactionUsage({ messages, tools, lastApiPromptTokens: 203_297 });
    expect(withApi.effectiveUsed).toBe(203_297);
    expect(withApi.effectiveUsed).toBeGreaterThan(local.effectiveUsed);
    expect(withApi.apiPrompt).toBe(203_297);
  });

  it('estimateToolsTokens 对空 tools 返回 0', () => {
    expect(estimateToolsTokens(undefined)).toBe(0);
    expect(estimateToolsTokens([])).toBe(0);
  });
});

describe('ContextCompactor 双轨占用判定', () => {
  const origWindow = process.env.ICE_CONTEXT_WINDOW;

  beforeEach(() => {
    process.env.ICE_CONTEXT_WINDOW = String(CONTEXT_WINDOW);
  });

  afterEach(() => {
    if (origWindow === undefined) delete process.env.ICE_CONTEXT_WINDOW;
    else process.env.ICE_CONTEXT_WINDOW = origWindow;
  });

  it('本地估算低于硬压缩线但 API prompt 超线 → 触发硬压缩', () => {
    const compactor = new ContextCompactor();
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'short task' },
    ];
    const hardLine = Math.floor(CONTEXT_WINDOW * HARD_COMPACTION_RATIO);

    expect(compactor.getEstimatedTokens(messages)).toBeLessThan(hardLine);
    expect(
      compactor.needsCompaction(messages, { lastApiPromptTokens: hardLine + 1 }),
    ).toBe(true);
  });

  it('API prompt 达微压缩线、本地仍低 → 触发微压缩', () => {
    const compactor = new ContextCompactor();
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'ok' }];
    const microLine = Math.floor(CONTEXT_WINDOW * MICRO_COMPACTION_RATIO);

    expect(compactor.getEstimatedTokens(messages)).toBeLessThan(microLine);
    expect(
      compactor.needsMicroCompaction(messages, { lastApiPromptTokens: microLine }),
    ).toBe(true);
    expect(
      compactor.needsCompaction(messages, { lastApiPromptTokens: microLine }),
    ).toBe(false);
  });

  it('显式 tokenThreshold 仍仅看 messages 本地估算（测试兼容）', () => {
    const compactor = new ContextCompactor({ tokenThreshold: 100 });
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(600) },
    ];
    expect(compactor.needsCompaction(messages)).toBe(true);
    expect(compactor.needsCompaction(messages, { lastApiPromptTokens: 50 })).toBe(true);
  });
});

describe('buildTotalTokenUsageWithContext', () => {
  const origWindow = process.env.ICE_CONTEXT_WINDOW;

  beforeEach(() => {
    process.env.ICE_CONTEXT_WINDOW = '200000';
  });

  afterEach(() => {
    if (origWindow === undefined) delete process.env.ICE_CONTEXT_WINDOW;
    else process.env.ICE_CONTEXT_WINDOW = origWindow;
  });

  it('圆环快照含 effectiveUsed 与 contextWindow', () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];
    const snap = buildTotalTokenUsageWithContext(messages, [], {
      lastInputTokens: 190_000,
      lastOutputTokens: 120,
    });
    expect(snap.contextWindow).toBe(200_000);
    expect(snap.effectiveUsed).toBe(190_000);
    expect(snap.inputTokens).toBe(190_000);
    expect(snap.outputTokens).toBe(120);
  });

  it('localOnly 压缩后圆环仅反映本地估算', () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'x'.repeat(4000) }];
    const snap = buildTotalTokenUsageWithContext(messages, [], {
      lastInputTokens: 203_000,
      localOnly: true,
    });
    expect(snap.effectiveUsed).toBeLessThan(203_000);
    expect(snap.inputTokens).toBe(203_000);
  });
});
