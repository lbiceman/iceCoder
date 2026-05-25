/**
 * P2-2 — 任务执行文档.md 末段 6 个建议 prompt 的自动化场景。
 *
 * A 纯读取 → 必须 free
 * B 小编辑 → 可 free
 * C 新增模块 → 应 forced
 * D 多文件重构 → 应 forced + modeLock
 * E checkpoint 恢复 → 必须 forced（checkpoint_resumed）
 * F graph 构建失败 → degraded forced（forcedDegradedTier=graph）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import { prepareHarnessRound } from '../../src/harness/harness-round-prep.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import {
  buildDualModeHarnessAsync,
  buildSupervisorConfig,
  collectSteps,
  createChatFn,
  createToolExecutor,
  finalResponse,
  makeTool,
  seedCheckpointResume,
  toolCallResponse,
} from './_fixtures/dual-mode-mocks.js';
import { createSupervisorRuntimeBridge } from '../../src/harness/supervisor/supervisor-bridge.js';

const originalSupervisorEnv = process.env.ICE_SUPERVISOR_MODE;

beforeEach(() => {
  delete process.env.ICE_SUPERVISOR_MODE;
});

afterEach(() => {
  if (originalSupervisorEnv === undefined) {
    delete process.env.ICE_SUPERVISOR_MODE;
  } else {
    process.env.ICE_SUPERVISOR_MODE = originalSupervisorEnv;
  }
  vi.restoreAllMocks();
});

describe('Dual-mode 6 scenarios (任务执行文档.md · P2-2)', () => {
  it('A · 纯读取：execution mode 全程 free', async () => {
    const tools = [makeTool('read_file'), makeTool('list_directory')];
    const { harness } = await buildDualModeHarnessAsync({
      tools,
      supervisorMode: 'adaptive',
      executionModeOverrides: { writeTargetsEnterThreshold: 0 },
    });
    const { events, push } = collectSteps();

    const result = await harness.run(
      '请分析 src/harness/harness.ts 的架构',
      createChatFn([
        toolCallResponse([{ id: 'r1', name: 'read_file', args: { path: 'src/harness/harness.ts' } }]),
        finalResponse('架构分析完成。'),
      ]),
      push,
    );

    expect(events.some(e => e.type === 'execution_mode_enter')).toBe(false);
    expect(result.loopState.executionMode).toBe('free');
  });

  it('B · 小编辑：adaptive 首轮无 graph，可保持 free', async () => {
    const tools = [makeTool('edit_file')];
    const { harness } = await buildDualModeHarnessAsync({
      tools,
      supervisorMode: 'adaptive',
      executionModeOverrides: {
        writeTargetsEnterThreshold: 1,
        modeLockRounds: 0,
      },
    });
    const { events, push } = collectSteps();

    const result = await harness.run(
      '修改 logger 中一处字符串',
      createChatFn([
        toolCallResponse([{ id: 'e1', name: 'edit_file', args: { path: 'src/logger.ts' } }]),
        finalResponse('已修改。'),
      ]),
      push,
    );

    // §I3：adaptive 关键 intent 首轮不 init graph；单写目标不触发 multi_write → 可 free。
    expect(events.filter(e => e.type === 'task_graph_init')).toHaveLength(0);
    expect(result.loopState.executionMode).toBe('free');
  });

  it('C · 新增模块：strict 首轮 init graph，应进入 forced', async () => {
    const tools = [makeTool('edit_file'), makeTool('write_file')];
    const { harness } = await buildDualModeHarnessAsync({
      tools,
      supervisorMode: 'strict',
      executionModeOverrides: { modeLockRounds: 0, forcedMinDwellRounds: 0 },
    });
    const { events, push } = collectSteps();

    const result = await harness.run(
      '新增 branch tracker 模块',
      createChatFn([finalResponse('模块已规划。')]),
      push,
    );

    const enter = events.find(e => e.type === 'execution_mode_enter');
    expect(events.filter(e => e.type === 'task_graph_init')).toHaveLength(1);
    expect(enter?.executionMode?.executionMode).toBe('forced');
    expect(result.loopState.executionMode).toBe('forced');
  });

  it('D · 多文件重构：应进入 forced 且带 modeLock', async () => {
    const tools = [makeTool('edit_file'), makeTool('write_file')];
    const { harness } = await buildDualModeHarnessAsync({
      tools,
      supervisorMode: 'strict',
      executionModeOverrides: {
        modeLockRounds: 2,
        forcedMinDwellRounds: 0,
        stableRoundsExitThreshold: 99,
      },
    });
    const { events, push } = collectSteps();

    const result = await harness.run(
      '重构 task graph checkpoint 相关代码',
      createChatFn([finalResponse('开始重构。')]),
      push,
    );

    const enter = events.find(e => e.type === 'execution_mode_enter');
    expect(enter?.executionMode?.executionMode).toBe('forced');
    expect(result.loopState.executionMode).toBe('forced');
    expect(result.loopState.executionModeLockRemaining).toBeGreaterThan(0);
  });

  it('E · checkpoint 恢复：必须 forced（checkpoint_resumed signal）', async () => {
    const tools = [makeTool('read_file')];
    const { harness, sessionDir } = await buildDualModeHarnessAsync({
      tools,
      supervisorMode: 'adaptive',
      executionModeOverrides: { modeLockRounds: 0 },
    });
    await seedCheckpointResume(sessionDir, {
      executionMode: 'forced',
      executionModeLockRemaining: 0,
      executionModeEnteredBy: ['tool_failure'],
      executionModeEnteredByPrimary: 'tool_failure',
      executionModeEnteredAtRound: 3,
      pendingModeSignals: [],
      forcedTaskBearingRoundsSinceEntry: 0,
    });
    const { events, push } = collectSteps();

    const result = await harness.run(
      '从中断处继续实现',
      createChatFn([finalResponse('已恢复。')]),
      push,
    );

    const enter = events.find(e => e.type === 'execution_mode_enter');
    expect(enter).toMatchObject({
      executionMode: {
        executionMode: 'forced',
        enteredByPrimary: 'checkpoint_resumed',
      },
    });
    expect(result.loopState.executionMode).toBe('forced');
    expect(result.loopState.executionModeEnteredByPrimary).toBe('checkpoint_resumed');
  });

  it('F · graph 构建失败：forced 下 init 失败 → degraded tier + recovery_pending', async () => {
    vi.spyOn(GraphExecutor.prototype, 'initGraph').mockImplementation(() => {
      throw new Error('simulated graph build failure');
    });

    const supervisorConfig = buildSupervisorConfig({ supervisorMode: 'strict' });
    const bridge = createSupervisorRuntimeBridge(supervisorConfig, { memoryOnly: true });
    const graphExecutor = new GraphExecutor();
    const loopController = new LoopController({ maxRounds: 5 });
    const logger = new HarnessLogger();
    const compactor = new ContextCompactor({ threshold: 9999 });
    const memoryIntegration = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' });
    const pendingSignals: string[] = [];

    const state = {
      messages: [{ role: 'user' as const, content: '新增 logger 工具模块' }],
      tools: [makeTool('edit_file')],
      turnCount: 0,
      maxOutputTokensRecoveryCount: 0,
      llmRetryCount: 0,
      emptyResponseRetryCount: 0,
      consecutiveToolFailures: 0,
      consecutiveReadOnlyRounds: 0,
      noToolExecutionRecoveryCount: 0,
      taskSwitchInjected: false,
      stopHookContinuationCount: 0,
      transition: 'initial' as const,
      justCompacted: false,
      amnesiaRecoveryCount: 0,
      taskState: new TaskState('新增 logger 工具模块'),
      repoContext: new RepoContext(),
      runtimeStateHash: '',
      failedToolCallSignatures: new Map(),
      branchBudgetWarnedThisRound: false,
      verificationDigestInjectedThisRound: false,
      stepReviewedThisRound: false,
      supervisorPhase: 'free' as const,
      executionMode: 'forced' as const,
      executionModeLockRemaining: 0,
      executionModeEnteredBy: ['explicit_impl'] as const,
      pendingModeSignals: [] as import('../../src/types/supervisor.js').ModeSignal[],
      forcedTaskBearingRoundsSinceEntry: 0,
      submitModeSignal: (_source: string, signal: string) => {
        pendingSignals.push(signal);
      },
    };

    const prep = await prepareHarnessRound(
      {
        loopController,
        memoryIntegration,
        graphExecutor,
        contextCompactor: compactor,
        supervisorBridge: bridge,
        stopHookManager: { run: async () => ({ action: 'continue' as const }) } as never,
        checkpointManager: undefined,
        enqueueCheckpointPersist: async task => task(),
        resilienceV2Enabled: false,
        checkpointEngine: undefined,
        toolExecutor: createToolExecutor([makeTool('edit_file')]),
        permissionRules: [],
        workspaceRoot: process.cwd(),
        executionModeConfig: supervisorConfig.executionMode,
        executionModeDecisionEnabled: true,
        abortSignal: undefined,
      },
      {
        state,
        userMessage: '新增 logger 工具模块',
        chatFn: createChatFn([finalResponse('done')]),
        logger,
      },
    );

    expect(prep.action).toBe('continue');
    expect(state.forcedDegradedTier).toBe('graph');
    expect(pendingSignals).toContain('recovery_pending');
  });

  it('F · graph 构建失败：strict 首轮 init 抛错（free 段 markForcedDegraded 不生效）', async () => {
    vi.spyOn(GraphExecutor.prototype, 'initGraph').mockImplementation(() => {
      throw new Error('simulated graph build failure');
    });

    const tools = [makeTool('edit_file')];
    const { harness } = await buildDualModeHarnessAsync({
      tools,
      supervisorMode: 'strict',
      executionModeOverrides: { modeLockRounds: 0 },
    });
    const { events, push } = collectSteps();

    await expect(
      harness.run('新增 logger 工具模块', createChatFn([finalResponse('继续。')]), push),
    ).rejects.toThrow('simulated graph build failure');

    expect(events.filter(e => e.type === 'task_graph_init')).toHaveLength(0);
  });
});
