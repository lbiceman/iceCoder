import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Harness } from '../../src/harness/harness.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';
import type { ChatFunction, HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import type { ToolResult } from '../../src/tools/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
  };
}

function finalResponse(content: string): LLMResponse {
  return {
    content,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'test' },
    finishReason: 'stop',
  };
}

function createToolExecutor(tools: ToolDefinition[]): ToolExecutor {
  const registry = new ToolRegistry();
  for (const t of tools) {
    registry.register({
      definition: t,
      handler: async (): Promise<ToolResult> => ({ success: true, output: 'ok' }),
    });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

function minConfig(overrides?: Partial<HarnessConfig>): HarnessConfig {
  return {
    context: {
      systemPrompt: 'test',
      tools: overrides?.context?.tools ?? [makeTool('read_file')],
    },
    loop: { maxRounds: overrides?.loop?.maxRounds ?? 10 },
    compactionThreshold: overrides?.compactionThreshold ?? 9999,
    compactionTokenThreshold: overrides?.compactionTokenThreshold ?? 999999,
    memoryDir: '__test_nonexistent_memory_dir__',
    sessionDir: overrides?.sessionDir ?? '__test_nonexistent_session_dir__',
    ...overrides,
  };
}

function buildPausedCheckpoint(): TaskCheckpoint {
  return {
    version: 1,
    taskId: 'task-resume-fork',
    status: 'paused',
    userGoal: 'Implement survivors game',
    phase: 'verification',
    lastCompletedStep: 'npm test',
    nextSuggestedStep: 'fix build',
    taskState: {
      goal: 'Implement survivors roguelike with npm test and npm run build'.padEnd(120, '.'),
      intent: 'edit',
      phase: 'verification',
      filesRead: ['src/main.ts'],
      filesChanged: ['src/main.ts'],
      commandsRun: ['npm test'],
      verificationRequired: true,
      verificationStatus: 'failed',
    },
    repoContext: {
      filesRead: ['src/main.ts'],
      filesChanged: ['src/main.ts'],
      commandsRun: ['npm test', 'npm run build'],
      testCommands: ['npm test'],
      recentDiagnostics: ['build failed'],
    },
    failedToolCalls: ['run_command:npm run build'],
    messageCount: 200,
    loop: {
      currentRound: 50,
      totalToolCalls: 80,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function buildLongHistory(turns: number): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [{ role: 'system', content: 'system prompt' }];
  const anchor = 'Implement survivors roguelike with npm test and npm run build'.padEnd(120, '.');
  msgs.push({ role: 'user', content: anchor });
  for (let i = 0; i < turns; i++) {
    msgs.push(
      { role: 'assistant', content: '', toolCalls: [{ id: `tc-${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }] },
      { role: 'tool', toolCallId: `tc-${i}`, content: 'file '.repeat(400) },
    );
  }
  return msgs;
}

describe('Harness · checkpoint resume fork integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pre-flight fork shrinks long histories before first LLM call', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-resume-fork-'));
    await fs.writeFile(
      path.join(sessionDir, 'default.checkpoint.json'),
      JSON.stringify(buildPausedCheckpoint(), null, 2),
      'utf-8',
    );

    const existingMessages = buildLongHistory(70);
    expect(existingMessages.length).toBeGreaterThanOrEqual(141);

    const tools = [makeTool('read_file')];
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools }, sessionDir }), createToolExecutor(tools));

    let firstCallMessageCount = -1;
    let sawResumeSummary = false;
    const chatFn: ChatFunction = vi.fn().mockImplementation(async (messages: UnifiedMessage[]) => {
      if (firstCallMessageCount < 0) {
        firstCallMessageCount = messages.length;
      }
      sawResumeSummary = messages.some(m =>
        typeof m.content === 'string'
        && m.content.includes('<resume-checkpoint>')
        && m.content.includes('nextStep: fix build')
        && !m.content.includes('"version": 1'),
      );
      return finalResponse('resumed after fork');
    });

    const result = await harness.run(
      '继续',
      chatFn,
      undefined,
      existingMessages,
    );

    expect(result.content).toBe('resumed after fork');
    expect(sawResumeSummary).toBe(true);
    expect(firstCallMessageCount).toBeGreaterThan(0);
    expect(firstCallMessageCount).toBeLessThan(existingMessages.length + 5);
  });

  it('short resume history appends summary without fork telemetry shrink', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-resume-short-'));
    await fs.writeFile(
      path.join(sessionDir, 'default.checkpoint.json'),
      JSON.stringify(buildPausedCheckpoint(), null, 2),
      'utf-8',
    );

    const existingMessages: UnifiedMessage[] = [
      { role: 'user', content: 'Implement survivors roguelike with npm test'.padEnd(90, '.') },
      { role: 'assistant', content: 'working' },
    ];

    const harness = new Harness(
      minConfig({ context: { systemPrompt: 'test', tools: [makeTool('read_file')] }, sessionDir }),
      createToolExecutor([makeTool('read_file')]),
    );

    const chatFn: ChatFunction = vi.fn().mockImplementation(async (messages: UnifiedMessage[]) => {
      expect(messages.some(m =>
        typeof m.content === 'string'
        && m.content.includes('<resume-checkpoint>')
        && m.content.includes('fix build'),
      )).toBe(true);
      return finalResponse('short resume ok');
    });

    const result = await harness.run('继续', chatFn, undefined, existingMessages);
    expect(result.content).toBe('short resume ok');
  });
});
