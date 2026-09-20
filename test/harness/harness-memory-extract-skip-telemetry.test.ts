/**
 * Extract 跳过时须写入 skipReason，便于区分门控拒绝与空提取。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import {
  getMemoryTelemetry,
  resetMemoryTelemetry,
  type ExtractTelemetry,
} from '../../src/memory/file-memory/memory-telemetry.js';
import {
  registerAgentMemoryWriteGuard,
  registerLongTermMemoryWriteCap,
  resetSessionLongTermMemoryWriteCaps,
} from '../../src/memory/file-memory/memory-write-pipeline.js';
import type { LLMAdapterInterface, LLMResponse, UnifiedMessage } from '../../src/llm/types.js';

let tempDir: string;
const extractEvents: ExtractTelemetry[] = [];

const dummyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'dummy' };

const dummyLlm: LLMAdapterInterface = {
  async chat(): Promise<LLMResponse> {
    return { content: '', usage: dummyUsage, finishReason: 'stop' };
  },
  async stream(): Promise<LLMResponse> {
    return { content: '', usage: dummyUsage, finishReason: 'stop' };
  },
  async countTokens(): Promise<number> {
    return 1;
  },
};

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `extract-skip-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  extractEvents.length = 0;
  resetMemoryTelemetry();
  const telemetry = getMemoryTelemetry({ enableFileLog: false, enableConsoleLog: false });
  telemetry.on('telemetry', (event) => {
    if (event.type === 'memory_extract') extractEvents.push(event);
  });
});

afterEach(async () => {
  resetMemoryTelemetry();
  registerAgentMemoryWriteGuard(null);
  registerLongTermMemoryWriteCap(null);
  resetSessionLongTermMemoryWriteCaps();
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('HarnessMemoryIntegration extract skipReason', () => {
  it('ops 门控跳过时记录 skipReason=ops_task', async () => {
    const harness = new HarnessMemoryIntegration({ memoryDir: tempDir });
    harness.onLoopStart('用 zip 装 mysql', dummyLlm, {
      triggerUserMessage: '用 zip 装 mysql',
    });

    await (harness as unknown as {
      _extractMemoriesImpl: (ctx: {
        messages: UnifiedMessage[];
        turnCount: number;
        gateUserMessage: string;
        conversationStartIndex: number;
        commandsRun: string[];
      }) => Promise<void>;
    })._extractMemoriesImpl({
      messages: [
        { role: 'user', content: '用 zip 装 mysql' },
        { role: 'assistant', content: '开始安装' },
      ],
      turnCount: 5,
      gateUserMessage: '用 zip 装 mysql',
      conversationStartIndex: 0,
      commandsRun: [],
    });

    expect(extractEvents).toHaveLength(1);
    expect(extractEvents[0].extractedCount).toBe(0);
    expect(extractEvents[0].skipReason).toBe('ops_task');
    expect(getMemoryTelemetry().getSummary().totalExtracts).toBe(0);
    harness.dispose();
  });
});
