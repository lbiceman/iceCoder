import { describe, expect, it, vi } from 'vitest';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { ToolCall, UnifiedMessage } from '../../src/llm/types.js';
import type { AnalysisSupervisor } from '../../src/harness/supervisor/analysis-supervisor.js';

describe('request_analysis tool', () => {
  it('submits analysis through AnalysisSupervisor and returns immediately', async () => {
    const messages: UnifiedMessage[] = [];
    const tc: ToolCall = {
      id: 'analysis-1',
      name: 'request_analysis',
      arguments: {
        kind: 'explorer',
        task: 'Explore auth module',
        paths: ['src/auth'],
        keywords: ['oauth'],
      },
    };
    const requestAnalysis = vi.fn(() => ({
      taskId: 'asa-test',
      submitted: true,
      status: 'pending' as const,
    }));

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool: vi.fn() } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
        sessionId: 'sess-tool',
        analysisSupervisor: { requestAnalysis } as unknown as AnalysisSupervisor,
      },
      {
        toolCalls: [tc],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(requestAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-tool',
        kind: 'explorer',
        prompt: 'Explore auth module',
        scope: { paths: ['src/auth'], keywords: ['oauth'] },
      }),
      expect.objectContaining({ reason: 'request_analysis_tool' }),
    );
    expect(stats.totalCount).toBe(1);
    expect(messages[0]?.content).toContain('[Analysis Requested]');
    expect(messages[0]?.content).toContain('asa-test');
  });

  it('blocks write tools when analysis is pending', async () => {
    const messages: UnifiedMessage[] = [];
    const tc: ToolCall = {
      id: 'write-1',
      name: 'write_file',
      arguments: { path: 'src/auth.ts', content: 'updated' },
    };
    const hasPendingAnalyses = vi.fn(async () => true);
    const executeTool = vi.fn();

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
        sessionId: 'sess-tool',
        analysisSupervisor: { hasPendingAnalyses } as unknown as AnalysisSupervisor,
        harnessPolicyStats: {
          policyBlockCount: 0,
          missingFileBlockCount: 0,
          budgetBlockByPath: {},
        } as never,
      },
      {
        toolCalls: [tc],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(hasPendingAnalyses).toHaveBeenCalledWith('sess-tool');
    expect(stats.policyBlockedSignatures).toHaveLength(1);
    expect(messages[0]?.content).toContain('background analysis is still pending');
  });
});
