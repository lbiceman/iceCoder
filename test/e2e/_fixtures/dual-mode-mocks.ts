import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

import { Harness } from '../../../src/harness/harness.js';
import type { TaskCheckpoint } from '../../../src/harness/checkpoint.js';
import { resolveSupervisorConfig } from '../../../src/harness/supervisor/supervisor-config.js';
import { createSupervisorRuntimeBridge } from '../../../src/harness/supervisor/supervisor-bridge.js';
import type {
  ChatFunction,
  HarnessConfig,
  HarnessStepEvent,
} from '../../../src/harness/types.js';
import type { LLMResponse, ToolDefinition } from '../../../src/llm/types.js';
import { ToolExecutor } from '../../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../../src/tools/tool-registry.js';
import type { ToolResult } from '../../../src/tools/types.js';
import { emptyRuntimeCheckpointV2 } from '../../../src/types/runtime-checkpoint.js';
import type { ResolvedSupervisorConfig } from '../../../src/types/supervisor.js';

export function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
  };
}

export function makeUsage(input = 100, output = 50) {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, provider: 'test' };
}

export function finalResponse(content: string): LLMResponse {
  return { content, usage: makeUsage(), finishReason: 'stop' };
}

export function toolCallResponse(
  calls: { id: string; name: string; args?: Record<string, unknown> }[],
): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: makeUsage(),
    finishReason: 'tool_calls',
  };
}

export function createToolExecutor(
  tools: ToolDefinition[],
  handler: (args: Record<string, unknown>) => Promise<ToolResult> = async () => ({
    success: true,
    output: 'ok',
  }),
): ToolExecutor {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register({ definition: tool, handler });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

export function createChatFn(
  responses: LLMResponse[],
  onCall?: () => void,
): ChatFunction {
  const queue = [...responses];
  return vi.fn().mockImplementation(async () => {
    onCall?.();
    return queue.length > 0 ? queue.shift()! : finalResponse('fallback');
  });
}

export function minConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const tools = overrides.context?.tools ?? [makeTool('read_file')];
  return {
    context: {
      systemPrompt: 'You are a test assistant.',
      tools,
    },
    loop: {
      maxRounds: overrides.loop?.maxRounds ?? 10,
      tokenBudget: overrides.loop?.tokenBudget,
      timeout: overrides.loop?.timeout,
      signal: overrides.loop?.signal,
    },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999999,
    memoryDir: '__test_nonexistent_memory_dir__',
    ...overrides,
  };
}

export async function tempSessionDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-dual-mode-'));
}

export interface BuildDualModeHarnessOptions {
  tools?: ToolDefinition[];
  supervisorMode?: 'off' | 'adaptive' | 'strict';
  executionModeOverrides?: Partial<ResolvedSupervisorConfig['executionMode']>;
  harnessOverrides?: Partial<HarnessConfig>;
}

export function buildSupervisorConfig(options: BuildDualModeHarnessOptions = {}): ResolvedSupervisorConfig {
  return resolveSupervisorConfig({
    mode: options.supervisorMode ?? 'adaptive',
    executionMode: {
      modeLockRounds: 2,
      writeTargetsEnterThreshold: 1,
      stableRoundsExitThreshold: 0,
      forcedMinDwellRounds: 0,
      ...options.executionModeOverrides,
    },
  }, {});
}

export async function buildDualModeHarnessAsync(
  options: BuildDualModeHarnessOptions = {},
): Promise<{ harness: Harness; supervisorConfig: ResolvedSupervisorConfig; sessionDir: string }> {
  const supervisorConfig = buildSupervisorConfig(options);
  const tools = options.tools ?? [makeTool('read_file')];
  const sessionDir = await tempSessionDir();
  const bridge = createSupervisorRuntimeBridge(supervisorConfig, { memoryOnly: true });
  const harness = new Harness(minConfig({
    context: { systemPrompt: 'test', tools },
    sessionDir,
    supervisorConfig,
    globalPolicy: supervisorConfig.globalPolicy,
    supervisorBridge: bridge,
    ...options.harnessOverrides,
  }), createToolExecutor(tools));
  return { harness, supervisorConfig, sessionDir };
}

export function buildRunningCheckpoint(): TaskCheckpoint {
  return {
    version: 1,
    taskId: 'resume-task',
    status: 'running',
    userGoal: 'resume implementation',
    phase: 'editing',
    taskState: {
      goal: 'resume implementation',
      intent: 'question',
      phase: 'editing',
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      verificationRequired: false,
      verificationStatus: 'not_required',
    },
    repoContext: {
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      testCommands: [],
      recentDiagnostics: [],
    },
    failedToolCalls: [],
    messageCount: 1,
    loop: {
      currentRound: 3,
      totalToolCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export async function seedCheckpointResume(
  sessionDir: string,
  supervisorState: NonNullable<ReturnType<typeof emptyRuntimeCheckpointV2>['supervisorState']>,
): Promise<void> {
  const runtimeV2 = emptyRuntimeCheckpointV2('manual');
  runtimeV2.supervisorState = supervisorState;
  await fs.writeFile(
    path.join(sessionDir, 'default.checkpoint.json'),
    JSON.stringify({ ...buildRunningCheckpoint(), runtimeV2 }, null, 2),
    'utf-8',
  );
}

export type StepCollector = (event: HarnessStepEvent) => void;

export function collectSteps(): { events: HarnessStepEvent[]; push: StepCollector } {
  const events: HarnessStepEvent[] = [];
  return { events, push: event => events.push(event) };
}
