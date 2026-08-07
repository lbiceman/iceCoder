import { describe, expect, it, vi } from 'vitest';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { Harness } from '../../src/harness/harness.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import { initializeToolSystem } from '../../src/tools/index.js';
import { SHELL_COLLAB_TOOL_NAMES, SHELL_ONLY_TOOL_NAMES } from '../../src/tools/shell-collab-tools.js';

function definition(name: string): ToolDefinition {
  return {
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {} },
  };
}

const shellDefinitions = SHELL_COLLAB_TOOL_NAMES.map(definition);

function harnessConfig(enableRequestAnalysis?: boolean): HarnessConfig {
  return {
    context: {
      systemPrompt: 'test',
      tools: shellDefinitions,
    },
    loop: { maxRounds: 3 },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999999,
    memoryDir: '__test_nonexistent_memory_dir__',
    enableRequestAnalysis,
  };
}

describe('Shell collaboration Harness tool policy', () => {
  it('does not inject request_analysis when disabled', async () => {
    const chat = vi.fn(async (): Promise<LLMResponse> => ({
      content: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
    }));
    const harness = new Harness(
      harnessConfig(false),
      { executeTool: vi.fn() } as never,
    );

    await harness.run('continue', chat);

    const toolNameLists = chat.mock.calls.map(call => {
      const options = call[1] as { tools?: ToolDefinition[] } | undefined;
      return options?.tools?.map(tool => tool.name) ?? [];
    });
    expect(toolNameLists).toContainEqual([...SHELL_COLLAB_TOOL_NAMES]);
    expect(toolNameLists.every(names => !names.includes('request_analysis'))).toBe(true);
  });

  it('keeps request_analysis enabled by default for ordinary Harness runs', async () => {
    const chat = vi.fn(async (): Promise<LLMResponse> => ({
      content: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
    }));
    const harness = new Harness(
      harnessConfig(),
      { executeTool: vi.fn() } as never,
    );

    await harness.run('continue', chat);

    const toolNameLists = chat.mock.calls.map(call => {
      const options = call[1] as { tools?: ToolDefinition[] } | undefined;
      return options?.tools?.map(tool => tool.name) ?? [];
    });
    expect(toolNameLists.some(names => names.includes('request_analysis'))).toBe(true);
  });

  it('blocks forged calls absent from currentTools before reaching ToolExecutor', async () => {
    const executeTool = vi.fn();
    const messages: UnifiedMessage[] = [];
    const toolCalls = [
      'run_command',
      'glob',
      'parse_document',
      'mcp_fake_exec',
      'request_analysis',
    ].map((name, index) => ({
      id: `forged-${index}`,
      name,
      arguments: {},
    }));

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: '/tmp/workspace',
      },
      {
        toolCalls,
        currentTools: shellDefinitions,
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(stats.policyBlockedSignatures).toHaveLength(toolCalls.length);
    expect(messages).toHaveLength(toolCalls.length);
    expect(messages.every(message =>
      message.role === 'tool'
      && typeof message.content === 'string'
      && message.content.includes('not available in this turn'),
    )).toBe(true);
  });

  it('keeps shell-only PTY tools out of the global ToolSystem used by /api/tools', async () => {
    const globalTools = initializeToolSystem({
      workDir: '/tmp/workspace',
      fileParser: {} as never,
    });

    for (const name of SHELL_ONLY_TOOL_NAMES) {
      expect(globalTools.registry.has(name)).toBe(false);
      await expect(globalTools.executor.executeTool({
        id: `global-${name}`,
        name,
        arguments: {},
      })).resolves.toMatchObject({
        success: false,
        error: `Unknown tool: ${name}`,
      });
    }
  });
});
