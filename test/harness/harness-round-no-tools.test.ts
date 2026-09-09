import { describe, expect, it, vi } from 'vitest';

import { handleNoToolCalls } from '../../src/harness/harness-round-no-tools.js';
import { evaluateIncompleteTaskStopHook } from '../../src/harness/incomplete-task-stop-hook.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { StopHookManager } from '../../src/harness/stop-hooks.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import {
  normalizeOperationOutcome,
  OperationOutcomeLedger,
} from '../../src/harness/operation-outcome.js';
import { TaskAcceptanceTracker } from '../../src/harness/task-acceptance-tracker.js';

function makeState(
  messages: UnifiedMessage[],
  goal = '运行测试',
): HarnessRunState {
  const loopController = new LoopController({ maxRounds: 10 });
  return {
    messages,
    tools: [
      { name: 'run_command', description: 'run', parameters: { type: 'object', properties: {} } },
      { name: 'file_info', description: 'info', parameters: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    ],
    turnCount: 1,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    reasoningOnlyRecoveryCount: 0,
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    completionGateContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: new TaskState(goal),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    stepReviewedThisRound: false,
    executionMode: 'free',
    executionModeLockRemaining: 0,
    executionModeEnteredBy: [],
    pendingModeSignals: [],
    forcedTaskBearingRoundsSinceEntry: 0,
    recoveryPendingSticky: false,
    stableRoundsSinceLastFailure: 0,
    filesChangedAtRoundStart: 0,
    branchSwitchedThisRound: false,
  };
}

function withDefaultHook(manager: StopHookManager): StopHookManager {
  manager.register(async (messages, lastContent) =>
    evaluateIncompleteTaskStopHook(messages, lastContent),
  );
  return manager;
}

function makeDeps(stopHookManager: StopHookManager) {
  return {
    loopController: new LoopController({ maxRounds: 10 }),
    stopHookManager,
    memoryIntegration: { getSessionMemoryForCompact: async () => null } as any,
    graphExecutor: { hasGraph: () => false, advanceOrComplete: () => ({ graphDone: false }) } as any,
    enqueueCheckpointPersist: async (t: () => Promise<void>) => t(),
  };
}

function makeLogger() {
  return {
    loopStop: vi.fn(),
    getEntries: vi.fn(() => []),
  } as any;
}

describe('handleNoToolCalls resume fixes', () => {
  it('allows a direct answer when no explicit pending work requires tools', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前完成' },
      { role: 'user', content: '运行测试' },
    ];
    const state = makeState(messages);
    const loopController = new LoopController({ maxRounds: 10 });

    const result = await handleNoToolCalls(
      {
        loopController,
        stopHookManager: new StopHookManager(),
        memoryIntegration: { getSessionMemoryForCompact: async () => null } as any,
        graphExecutor: { hasGraph: () => false, advanceOrComplete: () => ({ graphDone: false }) } as any,
        enqueueCheckpointPersist: async (t) => t(),
      },
      {
        state,
        response: { content: '我会运行测试。', finishReason: 'stop' },
        userMessage: '运行测试',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.noToolExecutionRecoveryCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// stop hook 状态门控：question / docs / 已完成工程任务直接 model_done
// ═══════════════════════════════════════════════════════════════
describe('handleNoToolCalls — stop hook 状态门控', () => {
  it('question 意图即使回复含「I will fix」也跳过 hook 直接 model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '为什么测试失败' },
    ];
    const state = makeState(messages, '为什么测试失败');
    expect(state.taskState.snapshot().intent).toBe('question');

    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: { content: '原因 A 和 B。I will fix it later.', finishReason: 'stop' },
        userMessage: '为什么测试失败',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.stopHookContinuationCount).toBe(0);
    expect(state.noToolExecutionRecoveryCount).toBe(0);
  });

  it('docs 意图无写文件且模型自承未完成 → stop hook 拦截', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '帮我写 readme 文档' },
    ];
    const state = makeState(messages, '帮我写 readme 文档');
    expect(state.taskState.snapshot().intent).toBe('docs');

    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: {
          content: '# README\n\n项目简介… still need to add 部署章节。',
          finishReason: 'stop',
        },
        userMessage: '帮我写 readme 文档',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('continue');
    expect(state.stopHookContinuationCount).toBe(1);
  });

  it('工程任务已动过工具且 verification 通过 → 跳过 hook 直接 model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '修复登录 bug' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'run_command', arguments: { command: 'npm test' } }] },
      { role: 'tool', content: 'pass', toolCallId: 't1' },
    ];
    const state = makeState(messages, '修复登录 bug');
    state.taskState.markVerificationPassed();

    const summary = '修复完成。npm test 全过，manifest 与 colorVariance 审计通过。';
    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: { content: summary, finishReason: 'stop' },
        userMessage: '修复登录 bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.stopHookContinuationCount).toBe(0);
  });

  it('工程任务无工具 + 模型自承未完成 → hook 拦截要求继续', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '实现登录功能' },
    ];
    const state = makeState(messages, '实现登录功能');
    expect(state.taskState.snapshot().intent).toBe('edit');

    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: { content: '接下来我会实现登录逻辑。', finishReason: 'stop' },
        userMessage: '实现登录功能',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('continue');
    expect(state.stopHookContinuationCount).toBe(1);
  });
});

describe('handleNoToolCalls — 收尾单元测试提示', () => {
  it('仅 md 变更 → 直接 model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '整理 ant design 组件到桌面 md' },
    ];
    const state = makeState(messages, '整理 ant design 组件到桌面 md');
    state.taskState.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'C:\\Desktop\\doc.md' } },
      { success: true, output: 'ok' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '文档已生成完成。', finishReason: 'stop' },
        userMessage: '整理 ant design 组件到桌面 md',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.completionGateContinuationCount).toBe(0);
  });

  it('仅 md 变更未跑测 → 不 inject verification gate', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '写一份 md 报告' },
    ];
    const state = makeState(messages, '写一份 md 报告');
    state.taskState.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/tmp/report.md' } },
      { success: true, output: 'ok' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '报告写好了。', finishReason: 'stop' },
        userMessage: '写一份 md 报告',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    expect(state.completionGateContinuationCount).toBe(0);
  });

  it('没有显式硬验证时不因变更类型追加验证轮', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '完成', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.completionGateContinuationCount).toBe(0);
    logSpy.mockRestore();
  });

  it('旧验证状态不会重新形成隐形硬门控', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '改动很小，无需跑测。', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.taskState.snapshot().verificationStatus).toBe('required');
  });

  it('软验证只来自提示词而不强制 continue', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '完成', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    expect(state.completionGateContinuationCount).toBe(0);
  });

  it('没有显式条件时不因缺少某种工具而阻塞', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }];
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '完成', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
  });

  it('统一门控不读取旧验证计数', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '完成', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
  });

  it('工程变更 npm test 通过后 → model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'all passed' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '完成', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
  });

  it('旧验证失败状态本身不触发第二套门控', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/Main.java' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: '', error: 'exit 1' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '测试失败了，我先总结。', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    expect(state.completionGateContinuationCount).toBe(0);
  });

  it('npm test 失败加强提示后再次收尾 → model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'fix bug' },
    ];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: '', error: 'exit 1' },
    );

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '测试仍失败，先总结。', finishReason: 'stop' },
        userMessage: 'fix bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
  });

  it('显式交付目标只注入一次统一收尾提示', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '整理成 md 文档放到桌面' },
    ];
    const state = makeState(messages, '整理成 md 文档放到桌面');
    state.noToolExecutionRecoveryCount = 1;

    const result = await handleNoToolCalls(
      makeDeps(new StopHookManager()),
      {
        state,
        response: { content: '文档已经整理好了。', finishReason: 'stop' },
        userMessage: '整理成 md 文档放到桌面',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('continue');
    expect(state.completionGateContinuationCount).toBe(1);
    expect(messages.at(-1)?.content).toMatch(/Completion Gate/);
  });
});

describe('handleNoToolCalls — 通用收尾协议', () => {
  it('简单源码修改有成功回执时不强制追加测试轮', async () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: '修改一处文本' }];
    const state = makeState(messages, '修改一处文本');
    state.operationOutcomes = new OperationOutcomeLedger();
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.py' } },
      { success: true, output: 'updated' },
    );
    state.operationOutcomes.record(normalizeOperationOutcome(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.py' } },
      { success: true, output: 'updated' },
    ));

    const result = await handleNoToolCalls(makeDeps(new StopHookManager()), {
      state,
      response: { content: '修改完成。', finishReason: 'stop' },
      userMessage: '修改一处文本',
      currentTools: state.tools,
      tokenUsage: { input: 1, output: 1 },
      logger: makeLogger(),
    });

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.completionStatus).toBe('completed');
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.completionGateContinuationCount).toBe(0);
  });

  it('后台操作未结束时暂停且不报告完成', async () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: '运行后台任务' }];
    const state = makeState(messages, '运行后台任务');
    state.operationOutcomes = new OperationOutcomeLedger();
    state.operationOutcomes.record(normalizeOperationOutcome(
      { id: 's1', name: 'run_command', arguments: { command: 'python worker.py' } },
      {
        success: true,
        output: JSON.stringify({ mode: 'background', status: 'running', taskId: 'bg_1' }),
      },
    ));

    const result = await handleNoToolCalls(makeDeps(new StopHookManager()), {
      state,
      response: { content: '任务完成。', finishReason: 'stop' },
      userMessage: '运行后台任务',
      currentTools: state.tools,
      tokenUsage: { input: 1, output: 1 },
      logger: makeLogger(),
    });

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.completionStatus).toBe('paused');
      expect(result.result.loopState.stopReason).toBe('completion_paused');
      expect(result.result.content).toMatch(/未结束/);
    }
  });

  it('相同 required 阻塞快照只续轮一次，随后暂停', async () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: '必须运行 `make verify` 后才能结束' }];
    const state = makeState(messages, '必须运行 `make verify` 后才能结束');
    state.taskAcceptance = new TaskAcceptanceTracker('必须运行 `make verify` 后才能结束');
    state.operationOutcomes = new OperationOutcomeLedger();

    const first = await handleNoToolCalls(makeDeps(new StopHookManager()), {
      state,
      response: { content: '已完成。', finishReason: 'stop' },
      userMessage: '必须运行 `make verify` 后才能结束',
      currentTools: state.tools,
      tokenUsage: { input: 1, output: 1 },
      logger: makeLogger(),
    });
    expect(first.action).toBe('continue');
    expect(state.completionGateContinuationCount).toBe(1);

    const second = await handleNoToolCalls(makeDeps(new StopHookManager()), {
      state,
      response: { content: '还是完成了。', finishReason: 'stop' },
      userMessage: '必须运行 `make verify` 后才能结束',
      currentTools: state.tools,
      tokenUsage: { input: 1, output: 1 },
      logger: makeLogger(),
    });
    expect(second.action).toBe('return');
    if (second.action === 'return') {
      expect(second.result.loopState.stopReason).toBe('completion_paused');
      expect(second.result.completionStatus).toBe('paused');
    }
  });
});
