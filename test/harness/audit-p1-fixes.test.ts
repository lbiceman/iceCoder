/**
 * Harness 审计 P1（#10–#18）中执行层的回归测试。见 docs/harness/Harness-审计修复清单.md。
 * 收尾判定（#10/#11/#12/#15/#17）的用例在 harness-round-no-tools / completion-state /
 * harness-stop-verification / verification-state 各自的测试里。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ToolCall, UnifiedMessage } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolHandler } from '../../src/tools/types.js';
import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { classifyToolRoundProgress } from '../../src/harness/tool-round-progress.js';
import { recordToolOperationOutcomes, OperationOutcomeLedger } from '../../src/harness/operation-outcome.js';

function executorFor(handlers: Record<string, ToolHandler>): ToolExecutor {
  const registry = new ToolRegistry();
  for (const [name, handler] of Object.entries(handlers)) {
    registry.register({
      definition: { name, description: name, parameters: { type: 'object', properties: {} } },
      handler,
    });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 30_000 });
}

const logger = { toolCall: () => {}, toolResult: () => {} } as never;

function toolContent(messages: UnifiedMessage[], id: string): string {
  return String(messages.find(m => m.role === 'tool' && m.toolCallId === id)?.content ?? '');
}

describe('#13 permission / user denials are policy blocks, not progress', () => {
  const write: ToolCall = { id: 'w1', name: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } };

  it.each([
    {
      label: 'deny rule',
      deps: { permissionRules: [{ pattern: 'write_file', permission: 'deny' as const, reason: 'read-only repo' }] },
      disposition: 'policy_block',
    },
    {
      label: 'user rejects confirm',
      deps: {
        permissionRules: [{ pattern: 'write_file', permission: 'confirm' as const }],
        onConfirm: async () => false,
      },
      disposition: 'user_denied',
    },
    {
      label: 'confirm without handler',
      deps: { permissionRules: [{ pattern: 'write_file', permission: 'confirm' as const }] },
      disposition: 'policy_block',
    },
  ])('$label', async ({ deps, disposition }) => {
    const handler = vi.fn<ToolHandler>(async () => ({ success: true, output: 'written' }));
    const messages: UnifiedMessage[] = [{ role: 'assistant', content: '', toolCalls: [write] }];
    const taskState = new TaskState('edit src/a.ts');
    const onStep = vi.fn();

    const stats = await executeToolCallsStreaming({
      toolExecutor: executorFor({ write_file: handler }),
      loopController: new LoopController({ maxRounds: 3 }),
      workspaceRoot: process.cwd(),
      ...deps,
    }, {
      toolCalls: [write],
      messages,
      logger,
      onStep,
      taskState,
      repoContext: new RepoContext(),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(stats.policyBlockedSignatures).toHaveLength(1);
    expect(stats.failedCount).toBe(0);
    expect(classifyToolRoundProgress({
      executableToolCalls: [write],
      failedSignatures: stats.failedSignatures,
      policyBlockedSignatures: stats.policyBlockedSignatures,
    })).toBe('all_failed_or_blocked');
    expect(taskState.snapshot().filesChanged).toEqual([]);
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result', toolCallId: 'w1', toolSuccess: false }));

    const ledger = new OperationOutcomeLedger();
    const [outcome] = recordToolOperationOutcomes(ledger, {
      toolCalls: [write],
      messages,
      failedSignatures: stats.failedSignatures,
      policyBlockedSignatures: stats.policyBlockedSignatures,
    });
    expect(outcome?.disposition).toBe(disposition);
  });
});

describe('#14 abort keeps results of tools that already finished', () => {
  it('records the finished tool and marks only the unfinished one interrupted', async () => {
    const ac = new AbortController();
    const done = vi.fn<ToolHandler>(async () => ({ success: true, output: 'fast result' }));
    const hang: ToolHandler = () => {
      setTimeout(() => ac.abort(), 30);
      return new Promise(() => {});
    };
    const calls: ToolCall[] = [
      { id: 'fast', name: 'fast_tool', arguments: {} },
      { id: 'slow', name: 'slow_tool', arguments: {} },
    ];
    const messages: UnifiedMessage[] = [{ role: 'assistant', content: '', toolCalls: calls }];
    const loopController = new LoopController({ maxRounds: 3, signal: ac.signal });

    const stats = await executeToolCallsStreaming({
      toolExecutor: executorFor({ fast_tool: done, slow_tool: hang }),
      loopController,
      permissionRules: [],
      workspaceRoot: process.cwd(),
    }, {
      toolCalls: calls,
      messages,
      logger,
      harnessAbortSignal: ac.signal,
    });

    expect(done).toHaveBeenCalledOnce();
    expect(toolContent(messages, 'fast')).toBe('fast result');
    expect(toolContent(messages, 'slow')).toMatch(/interrupted|aborted/i);
    expect(stats.failedSignatures.some(sig => sig.startsWith('fast_tool'))).toBe(false);
    expect(loopController.getState().totalToolCalls).toBeGreaterThanOrEqual(1);
  }, 10_000);
});
