import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LLMAdapter } from '../../src/llm/llm-adapter.js';
import {
  flushTokenUsageLog,
  readTokenUsageLogEvents,
  recordTokenUsage,
} from '../../src/llm/token-usage-log.js';
import type { LLMResponse, ProviderAdapter } from '../../src/llm/types.js';

const prevLog = process.env.ICE_TOKEN_USAGE_LOG;

afterEach(() => {
  if (prevLog === undefined) delete process.env.ICE_TOKEN_USAGE_LOG;
  else process.env.ICE_TOKEN_USAGE_LOG = prevLog;
});

describe('token-usage-log', () => {
  it('appends slim events and skips empty usage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-token-log-'));
    const logPath = path.join(dir, 'token-usage.jsonl');
    process.env.ICE_TOKEN_USAGE_LOG = logPath;

    recordTokenUsage({
      source: 'chat',
      inputTokens: 12,
      outputTokens: 3,
      model: 'gpt-4o',
      sessionId: 's1',
      provider: 'openai',
    });
    recordTokenUsage({
      source: 'memory_extract',
      inputTokens: 0,
      outputTokens: 0,
    });
    await flushTokenUsageLog();

    const events = await readTokenUsageLogEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'token_usage',
      source: 'chat',
      inputTokens: 12,
      outputTokens: 3,
      model: 'gpt-4o',
      sessionId: 's1',
      provider: 'openai',
    });
    expect(events[0].timestamp).toEqual(expect.any(String));
  });

  it('records successful LLMAdapter chat into the jsonl ledger', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-token-adapter-'));
    const logPath = path.join(dir, 'token-usage.jsonl');
    process.env.ICE_TOKEN_USAGE_LOG = logPath;

    const response: LLMResponse = {
      content: 'ok',
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10, provider: 'openai' },
      finishReason: 'stop',
    };
    const provider: ProviderAdapter & { model: string } = {
      name: 'openai',
      model: 'DeepSeek-V3.2',
      chat: async () => response,
      stream: async () => response,
      countTokens: async () => 1,
    };

    const adapter = new LLMAdapter({ maxRetries: 0, baseDelay: 1, maxDelay: 1 });
    adapter.registerProvider(provider);
    adapter.setDefaultProvider('openai');
    await adapter.chat([{ role: 'user', content: 'hi' }], {
      usageSource: 'memory_dream',
      sessionId: 'sess-9',
    });
    await flushTokenUsageLog();

    const events = await readTokenUsageLogEvents(logPath);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'token_usage',
        source: 'memory_dream',
        inputTokens: 8,
        outputTokens: 2,
        model: 'DeepSeek-V3.2',
        sessionId: 'sess-9',
        provider: 'openai',
      }),
    ]);
  });
});
