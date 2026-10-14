/**
 * Harness 审计 P4 的端到端 eval（脚本驱动 LLM，不打真实 API）。
 * 覆盖：run 成本护栏与 tracker 默认预算是两套数；只读轮提示、截断阈值、
 * 任务图同一工具重复上限都走收拢后的常量。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import {
  MAX_SAME_TOOL_REPEAT,
  OUTPUT_TOKEN_CEILING_RATIO,
  READONLY_ROUNDS_BEFORE_IMPLEMENT_HINT,
  TRUNCATED_WRITE_CONTENT_MIN_CHARS,
} from '../../src/harness/harness-constants.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import {
  isOutputAtTokenCeiling,
  shouldPlanTruncatedWriteToolRecovery,
} from '../../src/harness/harness-tool-truncation-recovery.js';
import {
  DEFAULT_TOKEN_TRACKER_BUDGET,
  TokenBudgetTracker,
} from '../../src/harness/token-budget.js';
import {
  DEFAULT_HARNESS_RUN_TOKEN_BUDGET,
  DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL,
  getHarnessTokenBudget,
} from '../../src/harness/token-budget-config.js';
import type { ChatFunction, HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolCall, ToolDefinition } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolHandler } from '../../src/tools/types.js';

function makeTool(name: string): ToolDefinition {
  return { name, description: `eval ${name}`, parameters: { type: 'object', properties: {} } };
}

function usage(inputTokens = 80, outputTokens = 40): LLMResponse['usage'] {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, provider: 'eval' };
}

function finalResponse(content: string): LLMResponse {
  return { content, usage: usage(), finishReason: 'stop' };
}

function toolCallResponse(calls: { id: string; name: string; args?: Record<string, unknown> }[]): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: usage(),
    finishReason: 'tool_calls',
  };
}

function createToolExecutor(handlers: Record<string, ToolHandler>): { executor: ToolExecutor; tools: ToolDefinition[] } {
  const registry = new ToolRegistry();
  const tools = Object.keys(handlers).map(makeTool);
  for (const t of tools) registry.register({ definition: t, handler: handlers[t.name]! });
  return {
    tools,
    executor: new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5_000 }),
  };
}

function minConfig(overrides: Partial<HarnessConfig> & { tools: ToolDefinition[] }): HarnessConfig {
  const { tools, context, loop, ...rest } = overrides;
  return {
    context: { systemPrompt: 'eval harness', tools, ...context },
    loop: {
      maxRounds: loop?.maxRounds ?? 12,
      timeout: loop?.timeout,
      signal: loop?.signal,
      tokenBudget: loop?.tokenBudget,
    },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999_999,
    memoryDir: '__test_nonexistent_memory_dir__',
    skipPermissionChecks: true,
    ...rest,
  };
}

function stubMemoryPersist(harness: Harness): void {
  const mem = (harness as unknown as {
    memoryIntegration: {
      sequentialExtract: () => Promise<void>;
      maybeUpdateSessionMemory: () => Promise<void>;
      maybeDream: () => Promise<void>;
      memoryDream: { recordSession: () => Promise<void> };
    };
  }).memoryIntegration;
  vi.spyOn(mem, 'sequentialExtract').mockResolvedValue(undefined);
  vi.spyOn(mem, 'maybeUpdateSessionMemory').mockResolvedValue(undefined);
  vi.spyOn(mem.memoryDream, 'recordSession').mockResolvedValue(undefined);
}

const READONLY_HINT = `reading/analyzing for ${READONLY_ROUNDS_BEFORE_IMPLEMENT_HINT} rounds`;

describe('eval: harness audit P4 #90 #91', () => {
  let workDir: string;

  beforeEach(async () => {
    process.env.ICE_EVAL_MODE = '1';
    workDir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-p4-'));
  });

  afterEach(async () => {
    delete process.env.ICE_EVAL_MODE;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('run cost fuse and tracker default stay different numbers', () => {
    expect(DEFAULT_HARNESS_RUN_TOKEN_BUDGET).toBe(1_000_000_000);
    expect(DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL).toBe(DEFAULT_HARNESS_RUN_TOKEN_BUDGET);
    expect(getHarnessTokenBudget()).toBe(DEFAULT_HARNESS_RUN_TOKEN_BUDGET);
    expect(DEFAULT_TOKEN_TRACKER_BUDGET).toBe(500_000);
    expect(new TokenBudgetTracker().getTotalBudget()).toBe(DEFAULT_TOKEN_TRACKER_BUDGET);
    expect(new TokenBudgetTracker({ totalBudget: getHarnessTokenBudget() }).getTotalBudget())
      .toBe(DEFAULT_HARNESS_RUN_TOKEN_BUDGET);
    expect(DEFAULT_TOKEN_TRACKER_BUDGET).toBeLessThan(DEFAULT_HARNESS_RUN_TOKEN_BUDGET);
  });

  it('a tiny loop token budget stops the run; the run fuse does not', async () => {
    const handlers = {
      read_file: async () => ({ success: true, output: 'file body' }),
    };

    const tight = createToolExecutor(handlers);
    const tightHarness = new Harness(minConfig({
      tools: tight.tools,
      workspaceRoot: workDir,
      loop: { maxRounds: 8, tokenBudget: 50 },
    }), tight.executor);
    stubMemoryPersist(tightHarness);
    const tightResult = await tightHarness.run('读一下文件', async () =>
      toolCallResponse([{ id: 'r1', name: 'read_file', args: { path: 'a.ts' } }]),
    );
    expect(tightResult.loopState.stopReason).toBe('token_budget');

    const wide = createToolExecutor(handlers);
    const wideHarness = new Harness(minConfig({
      tools: wide.tools,
      workspaceRoot: workDir,
      loop: { maxRounds: 8, tokenBudget: getHarnessTokenBudget() },
    }), wide.executor);
    stubMemoryPersist(wideHarness);
    let round = 0;
    const chatFn: ChatFunction = async () => {
      round += 1;
      if (round === 1) {
        return toolCallResponse([{ id: 'r1', name: 'read_file', args: { path: 'a.ts' } }]);
      }
      return finalResponse('看完了。');
    };
    const wideResult = await wideHarness.run('读一下文件', chatFn);
    expect(wideResult.loopState.stopReason).toBe('model_done');
  });

  it('nudges implementation only after the configured read-only streak', async () => {
    expect(READONLY_ROUNDS_BEFORE_IMPLEMENT_HINT).toBe(5);

    async function runReadOnlyRounds(rounds: number) {
      const { executor, tools } = createToolExecutor({
        read_file: async () => ({ success: true, output: 'file body' }),
      });
      const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
      stubMemoryPersist(harness);
      let seen = 0;
      const chatFn: ChatFunction = async () => {
        seen += 1;
        if (seen <= rounds) {
          return toolCallResponse([{ id: `r${seen}`, name: 'read_file', args: { path: 'a.ts' } }]);
        }
        return finalResponse('先读到这里。');
      };
      return harness.run('请修改 src/app.ts 的标题', chatFn);
    }

    const early = await runReadOnlyRounds(READONLY_ROUNDS_BEFORE_IMPLEMENT_HINT - 1);
    expect(early.loopState.stopReason).toBe('model_done');
    expect(early.messages.some(message => String(message.content).includes(READONLY_HINT))).toBe(false);

    const nudged = await runReadOnlyRounds(READONLY_ROUNDS_BEFORE_IMPLEMENT_HINT);
    expect(nudged.loopState.stopReason).toBe('model_done');
    expect(nudged.messages.some(message => String(message.content).includes(READONLY_HINT))).toBe(true);
  });

  it('treats output near the token ceiling and long path-less writes as truncated', () => {
    expect(OUTPUT_TOKEN_CEILING_RATIO).toBe(0.98);
    expect(TRUNCATED_WRITE_CONTENT_MIN_CHARS).toBe(500);
    expect(isOutputAtTokenCeiling(97, 100)).toBe(false);
    expect(isOutputAtTokenCeiling(98, 100)).toBe(true);

    const write = (content: string): ToolCall => ({
      id: 'w1',
      name: 'write_file',
      arguments: { content },
    });
    const below = shouldPlanTruncatedWriteToolRecovery({
      toolCalls: [write('x'.repeat(TRUNCATED_WRITE_CONTENT_MIN_CHARS - 1))],
      finishReason: 'tool_calls',
      outputTokens: 10,
      maxOutputTokens: 1000,
    });
    const atLimit = shouldPlanTruncatedWriteToolRecovery({
      toolCalls: [write('x'.repeat(TRUNCATED_WRITE_CONTENT_MIN_CHARS))],
      finishReason: 'tool_calls',
      outputTokens: 10,
      maxOutputTokens: 1000,
    });
    expect(below).toBe(false);
    expect(atLimit).toBe(true);
  });

  it('blocks the same tool only after the shared node-guard limit', () => {
    expect(MAX_SAME_TOOL_REPEAT).toBe(5);
    const executor = new GraphExecutor();
    executor.initGraph({ goal: '看看这个函数做什么', intent: 'question' });

    for (let i = 0; i < MAX_SAME_TOOL_REPEAT; i++) {
      expect(executor.checkToolCall('read_file').action).toBe('allow');
    }
    const over = executor.checkToolCall('read_file');
    expect(over.action).toBe('warn');
    expect(over.message).toContain(`上限 ${MAX_SAME_TOOL_REPEAT}`);
  });
});
