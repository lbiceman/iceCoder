/**
 * Harness — 核心循环引擎（状态机模式）。
 *
 * 使用 while(true) + 可变 State 对象的迭代模式，
 * 避免深度递归导致的栈溢出。
 *
 * 每轮迭代：
 * 1. 消息预处理（工具结果预算裁剪 → 上下文压缩）
 * 2. 调用 LLM
 * 3. 处理响应
 * 4. 决定 continue / stop
 *
 * state.transition 记录每次 continue 的原因，方便调试和测试。
 */

import type { UnifiedMessage } from '../llm/types.js';
import { estimateStringTokens } from '../llm/token-estimator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type {
  ExecutionModeConfig,
  GlobalModePolicy,
  ModeSignal,
  ModeSignalSource,
} from '../types/supervisor.js';
import type { SupervisorRuntimeBridge } from './supervisor/supervisor-bridge.js';
import type { TaskGraphSnapshot } from '../types/task-graph.js';

/** W1: 用于把 RepoContext 新增文件数粗略折算成 diff 行数，仅用于 large_diff 信号阈值参考。 */
const APPROX_LINES_PER_FILE_CHANGE = 60;

function countPendingGraphSteps(snapshot: TaskGraphSnapshot | null): number {
  if (!snapshot) return 0;
  let count = 0;
  for (const node of Object.values(snapshot.nodes)) {
    if (node.status === 'pending' || node.status === 'running') count++;
  }
  return count;
}
import type {
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  ChatFunction,
  StreamFunction,
} from './types.js';
import { ContextAssembler } from './context-assembler.js';
import { LoopController } from './loop-controller.js';
import { ContextCompactor, type CompactionConfig } from './context-compactor.js';
import { applyCheckpointResumeFork, stripResumeCheckpointMessages } from './checkpoint-resume-compact.js';
import { readCompactionContextWindowTokens } from './context-window-tier.js';
import { HarnessLogger } from './logger.js';
import { StopHookManager } from './stop-hooks.js';
import { TokenBudgetTracker } from './token-budget.js';
import { HarnessMemoryIntegration } from './harness-memory.js';
import { TaskState } from './task-state.js';
import { RepoContext } from './repo-context.js';
import { resolveSessionGoalAnchor, isPoisonedGoal } from './session-goal-anchor.js';
import { syncHydratedTaskState } from './resume-task-state.js';
import { syncTaskVerificationFromAcceptance } from './incomplete-completion.js';
import { VerificationOutputBuffer } from './verification-output-buffer.js';
import { TaskAcceptanceTracker } from './task-acceptance-tracker.js';
import { emptyHarnessPolicyStats } from './harness-policy-stats.js';
import { TaskCheckpointManager } from './checkpoint.js';
import { RuntimeTelemetry } from './runtime-telemetry.js';
import { BranchBudgetTracker } from './branch-budget.js';
import { CheckpointEngine, isResilienceV2Enabled } from './checkpoint-engine.js';
import { GraphExecutor } from './task-graph-executor.js';
import { ensureDelegateToSubagentTool } from './sub-agent-runner.js';
import { ModeDecisionEngine } from './supervisor/mode-decision-engine.js';
import { TaskRiskClassifier } from './supervisor/task-risk-classifier.js';
import { resolveSupervisorConfig } from './supervisor/supervisor-config.js';
import { DEFAULT_AGENT_MAX_OUTPUT_TOKENS } from '../web/routes/config.js';
import {
  buildModeDecisionContext,
  buildRuntimeExecutionState,
} from './supervisor/runtime-execution-state.js';
import {
  applyExecutionModeConstraints,
  syncExecutionModeLoopState,
} from './supervisor/execution-mode-constraints.js';
import {
  DEFAULT_COMPACTION_KEEP_RECENT,
  DEFAULT_COMPACTION_THRESHOLD,
} from './harness-constants.js';
import type { HarnessRunState } from './harness-run-state.js';
import { callHarnessLlm } from './harness-llm-call.js';
import { prepareHarnessRound } from './harness-round-prep.js';
import { handleNoToolCalls } from './harness-round-no-tools.js';
import { runHarnessToolRound } from './harness-tool-round.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import type { RoundPrepDeps } from './harness-round-prep.js';
import type { ToolExecutorDeps } from './harness-tool-executor.js';
import { getLatestRealUserText } from './harness-message-utils.js';
import { resolveLlmToolsForRound } from './casual-mode.js';
import { salvageTextToolCallsInResponse } from './text-tool-call-salvage.js';
import { applyUserMessageWorkspaceLock } from './session-workspace-store.js';

/** run() 内各子模块共享的运行时依赖（由 Harness 实例字段组装）。 */
export type HarnessRunDeps = RoundPrepDeps & ToolExecutorDeps & import('./harness-tool-round.js').ToolRoundDeps & {
  stopHookManager: StopHookManager;
  tokenBudgetTracker?: TokenBudgetTracker;
};

/**
 * Harness 是带工具调用的 LLM 迭代循环引擎。
 *
 * 用户 prompt 决定"做什么"，Harness 决定"怎么做"。
 * 只有在安全边界上，Harness 才会硬性覆盖用户意图。
 */
export class Harness {
  private contextAssembler: ContextAssembler;
  private loopController: LoopController;
  private contextCompactor: ContextCompactor;
  private toolExecutor: ToolExecutor;
  private stopHookManager: StopHookManager;
  private tokenBudgetTracker?: TokenBudgetTracker;
  private permissionRules: HarnessConfig['permissions'];
  private skipPermissionChecks: boolean;
  private onConfirm?: HarnessConfig['onConfirm'];
  private memoryIntegration: HarnessMemoryIntegration;
  private abortSignal?: AbortSignal;
  private checkpointManager?: TaskCheckpointManager;
  private checkpointPersistTail = Promise.resolve();
  private graphExecutor: GraphExecutor;
  private runtimeTelemetry?: RuntimeTelemetry;
  private workspaceRoot: string;
  private sessionDir?: string;
  private sessionId: string;
  private resilienceV2Enabled: boolean;
  private checkpointEngine?: CheckpointEngine;
  private globalPolicy?: HarnessConfig['globalPolicy'];
  private supervisorConfig?: HarnessConfig['supervisorConfig'];
  private supervisorBridge?: SupervisorRuntimeBridge;
  private modeDecisionEngine: ModeDecisionEngine;
  private taskRiskClassifier: TaskRiskClassifier;
  /**
   * L2-6 — 最近一次 before-LLM evaluate 阶段算出的 risk score（0..1）。
   * after-round 钩子 `bridge.evaluateAfterRound` 复用，避免在 tool-round 重复计算。
   * 默认 0.5（中性），adaptive.riskThreshold 默认 0.6 不直接候选。
   */
  private lastRiskScore = 0.5;
  private agentMaxOutputTokens: number;

  constructor(
    config: HarnessConfig,
    toolExecutor: ToolExecutor,
  ) {
    const context = {
      ...config.context,
      tools: ensureDelegateToSubagentTool(config.context.tools),
    };
    this.contextAssembler = new ContextAssembler(context);
    this.loopController = new LoopController(config.loop);
    this.agentMaxOutputTokens = config.loop.maxOutputTokens ?? DEFAULT_AGENT_MAX_OUTPUT_TOKENS;
    const compactionPartial: Partial<CompactionConfig> = {
      threshold: config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
      tokenThreshold: config.compactionTokenThreshold,
      keepRecent: config.compactionKeepRecent ?? DEFAULT_COMPACTION_KEEP_RECENT,
      enableLLMSummary: config.compactionEnableLLMSummary,
    };
    if (config.compactionMaxReinjectFiles != null) {
      compactionPartial.maxReinjectFiles = config.compactionMaxReinjectFiles;
    }
    this.contextCompactor = new ContextCompactor(compactionPartial);
    this.toolExecutor = toolExecutor;
    this.stopHookManager = new StopHookManager();
    this.permissionRules = config.permissions ?? [];
    this.skipPermissionChecks = config.skipPermissionChecks === true;
    this.onConfirm = config.onConfirm;
    this.abortSignal = config.loop.signal;
    this.workspaceRoot = config.workspaceRoot ?? process.cwd();
    this.sessionDir = config.sessionDir;
    this.sessionId = config.sessionId ?? 'default';
    // Batch 3：未显式注入 supervisorConfig 时回落到 off，避免悄悄改变 cli/web 入口的旧行为。
    // 调用方需要启用双模决策时，应显式传入 supervisorConfig，或在 config.json 中设置 supervisorMode。
    this.supervisorConfig = config.supervisorConfig ?? resolveSupervisorConfig({ mode: 'off' });
    this.globalPolicy = config.globalPolicy ?? this.supervisorConfig.globalPolicy;
    this.supervisorBridge = config.supervisorBridge;
    this.modeDecisionEngine = new ModeDecisionEngine(this.supervisorConfig.executionMode);
    this.taskRiskClassifier = new TaskRiskClassifier(this.supervisorConfig.executionMode);
    this.checkpointManager = config.sessionDir
      ? new TaskCheckpointManager(config.sessionDir, config.sessionId)
      : undefined;
    this.runtimeTelemetry = new RuntimeTelemetry(config.sessionDir, config.sessionId);

    this.resilienceV2Enabled = isResilienceV2Enabled();
    if (this.resilienceV2Enabled && config.sessionDir) {
      this.checkpointEngine = new CheckpointEngine(config.sessionDir, config.sessionId);
    }

    this.graphExecutor = new GraphExecutor();

    this.memoryIntegration = new HarnessMemoryIntegration({
      memoryDir: config.memoryDir,
      fileMemoryManager: config.fileMemoryManager,
      sessionDir: config.sessionDir,
      sessionId: config.sessionId,
      workspaceRoot: config.workspaceRoot,
    });

    if (config.loop.tokenBudget) {
      this.tokenBudgetTracker = new TokenBudgetTracker({
        totalBudget: config.loop.tokenBudget,
      });
    }
  }

  private buildRunDeps(): HarnessRunDeps {
    return {
      loopController: this.loopController,
      contextCompactor: this.contextCompactor,
      memoryIntegration: this.memoryIntegration,
      graphExecutor: this.graphExecutor,
      runtimeTelemetry: this.runtimeTelemetry,
      checkpointManager: this.checkpointManager,
      enqueueCheckpointPersist: (task) => this.enqueueCheckpointPersist(task),
      resilienceV2Enabled: this.resilienceV2Enabled,
      checkpointEngine: this.checkpointEngine,
      stopHookManager: this.stopHookManager,
      toolExecutor: this.toolExecutor,
      permissionRules: this.permissionRules ?? [],
      skipPermissionChecks: this.skipPermissionChecks,
      onConfirm: this.onConfirm,
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      tokenBudgetTracker: this.tokenBudgetTracker,
      executionModeConfig: this.supervisorConfig?.executionMode,
      executionModeDecisionEnabled: this.globalPolicy?.modeDecisionEngineEnabled ?? false,
      supervisorBridge: this.supervisorBridge,
      supervisorObserverSuppressInject: shouldSuppressObserverInject(this.globalPolicy),
      supervisorRiskScoreProvider: () => this.lastRiskScore,
      agentMaxOutputTokens: this.agentMaxOutputTokens,
      abortSignal: this.abortSignal,
    };
  }

  /** 将 checkpoint/v2 磁盘更新串行化（仅在有持久化路径时生效）。 */
  enqueueCheckpointPersist<T>(task: () => Promise<T>): Promise<T> {
    if (!this.checkpointManager && !this.checkpointEngine) {
      return task();
    }
    const run = () => task();
    const p = this.checkpointPersistTail.then(run, run);
    this.checkpointPersistTail = p.then(
      (): void => {},
      (): void => {},
    );
    return p;
  }

  private evaluateExecutionModeBeforeLlm(
    deps: HarnessRunDeps,
    state: HarnessRunState,
    round: number,
    onStep?: (event: HarnessStepEvent) => void,
  ): void {
    // W3：信号生命周期为「上一轮事件 → 本轮 evaluate 消费」。
    //   在 runHarnessToolRound 末段提交的 tool_failure / multi_write /
    //   recovery_pending 等信号会写入 state.pendingModeSignals，
    //   并在下一轮（即此处）被读取与清空，因此进入 forced 通常滞后 1 轮。
    //   tool_failure 常见来源：npm test 等 run_command 验收失败（非 edit 工具坏）；
    //   或 BranchBudget 拦 write（工具未执行）。见 branch-budget.ts 文件头。
    //   即时阻断由 Batch 5 的 ToolGate 在工具执行前单独处理，不在此 evaluate。
    const config = this.supervisorConfig?.executionMode;
    const policy = this.globalPolicy;
    if (!config || !policy) return;
    // W2: OFF 模式不应让 evaluate 产生任何副作用（不 submit signals、不写 state、不动 gates）。
    if (!policy.modeDecisionEngineEnabled) return;

    this.submitGraphModeSignals(deps, state);
    const graphSnapshot = deps.graphExecutor?.toSnapshot() ?? null;
    const pendingStepCount = countPendingGraphSteps(graphSnapshot);
    const graphState = {
      active: deps.graphExecutor?.hasGraph() ?? false,
      pendingStepCount,
      activeGraphHasImplementNode: deps.graphExecutor?.hasPendingImplementNode() ?? false,
    };
    // W1: 真实派生 RuntimeExecutionState 字段，不再硬编码 stub。
    const recoveryPending = (state.pendingModeSignals ?? []).includes('recovery_pending')
      || !!state.recoveryPendingSticky;
    const stableRounds = state.stableRoundsSinceLastFailure ?? 0;
    const repoSnap = state.repoContext.snapshot();
    const filesChangedSnapshot = state.filesChangedAtRoundStart ?? repoSnap.filesChanged.length;
    const accumulatedDiffLines = Math.max(0, repoSnap.filesChanged.length - filesChangedSnapshot)
      * APPROX_LINES_PER_FILE_CHANGE;
    const runtimeState = buildRuntimeExecutionState({
      round,
      readonlyToolNames: config.readonlyToolNames,
      plannedToolNames: [],
      graphState,
      forcedEntryRound: state.executionModeEnteredAtRound ?? null,
      forcedTaskBearingRoundsSinceEntry: state.forcedTaskBearingRoundsSinceEntry ?? 0,
      stableRounds,
      lastToolSuccess: state.consecutiveToolFailures === 0,
      recoveryPending,
      branchDebt: state.branchBudget?.recoverTriggerCount ?? 0,
      accumulatedDiffLines,
      branchSwitchedThisRound: !!state.branchSwitchedThisRound,
    });
    const riskLevel = this.taskRiskClassifier.classify(runtimeState);
    // L2-6：把 TaskRiskLevel 映射为 [0,1] riskScore（adaptive.riskThreshold 默认 0.6，
    //        L2 → 0.7 跨阈，L1 → 0.5 不跨阈，L0 → 0.2）。after-round 钩子复用。
    this.lastRiskScore = riskScoreFromLevel(riskLevel);
    const ctx = buildModeDecisionContext({
      round,
      executionMode: state.executionMode ?? policy.executionModeFloor,
      executionModeLockRemaining: state.executionModeLockRemaining ?? 0,
      supervisorPhase: state.supervisorPhase,
      supervisorMode: policy.supervisorMode,
      riskLevel,
      state: runtimeState,
      signals: state.pendingModeSignals ?? [],
    });
    const decision = this.modeDecisionEngine.evaluate(ctx);

    applyExecutionModeConstraints(
      {
        ...deps,
        onExecutionModeChanged: (nextMode) => this.applyExecutionModeGates(state, nextMode),
      },
      {
        state,
        decision,
        round,
        config,
        onStep,
      },
    );
    state.pendingModeSignals = [];
    syncExecutionModeLoopState(this.loopController, state);
  }

  /**
   * §2.8 / T12 — execution mode 切换时同步 BranchBudget / CheckpointEngine forced policy。
   * 唯一调用入口：applyExecutionModeConstraints 的 onExecutionModeChanged 回调。
   */
  private applyExecutionModeGates(state: HarnessRunState, nextMode: 'free' | 'forced'): void {
    const forced = nextMode === 'forced';
    state.branchBudget?.setEnabled(forced);
    this.checkpointEngine?.setForcedPolicy(forced);
  }

  private submitModeSignal(
    state: HarnessRunState,
    source: ModeSignalSource,
    signal: ModeSignal,
    payload?: Record<string, unknown>,
  ): void {
    state.pendingModeSignals ??= [];
    state.pendingModeSignals.push(signal);
    // W4：recovery_pending 跨轮 sticky，直到 forced exit 才清；
    // W1：branch_switched 写本轮 flag，下轮 prepareHarnessRound 重置。
    if (signal === 'recovery_pending') {
      state.recoveryPendingSticky = true;
    } else if (signal === 'branch_switched') {
      state.branchSwitchedThisRound = true;
    }
    this.modeDecisionEngine.submitSignal(source, signal, payload);
  }

  private submitGraphModeSignals(deps: HarnessRunDeps, state: HarnessRunState): void {
    if (!deps.graphExecutor?.hasGraph()) return;
    state.submitModeSignal?.('graph_executor', 'task_graph_active');
    const snapshot = deps.graphExecutor.toSnapshot();
    const hasPendingNode = snapshot
      ? Object.values(snapshot.nodes).some(node => node.status === 'pending' || node.status === 'running')
      : false;
    if (hasPendingNode) {
      state.submitModeSignal?.('graph_executor', 'pending_steps');
    }
  }

  /**
   * 执行核心循环（状态机模式）。
   */
  async run(
    userMessage: string,
    chatFn: ChatFunction,
    onStep?: (event: HarnessStepEvent) => void,
    existingMessages?: UnifiedMessage[],
    streamFn?: StreamFunction,
    userContentBlocks?: import('../llm/types.js').ContentBlock[],
  ): Promise<HarnessResult> {
    const logger = new HarnessLogger();
    // W1: Harness 实例可被复用（cli/web）；清空上一次 run 残留的未消费信号，
    // 避免熔断/abort/max_rounds 终止后引擎 submittedSignals 跨 run 泄漏。
    this.modeDecisionEngine.resetSubmittedSignals();
    // L2-6：新任务边界 — 复位 observer/drift/budget/RecoverySupervisor phase，
    //       否则前一任务残留信号会让本任务首轮直接进入 takeover 候选。
    this.supervisorBridge?.resetForNewTask();

    let messages: UnifiedMessage[];
    const messageContent = userContentBlocks ?? userMessage;
    if (existingMessages && existingMessages.length > 0) {
      messages = existingMessages;
      messages.push({ role: 'user', content: messageContent });
    } else {
      messages = this.contextAssembler.assembleInitialMessages(userMessage);
      if (userContentBlocks) {
        const lastUserIdx = messages.length - 1;
        if (messages[lastUserIdx]?.role === 'user') {
          messages[lastUserIdx] = { ...messages[lastUserIdx], content: userContentBlocks };
        }
      }
    }
    const activeCheckpoint = await this.checkpointManager?.loadActive();

    const plainUserText = typeof userMessage === 'string'
      ? userMessage
      : getLatestRealUserText(messages, '');
    let lockedWorkspaceRoot: string | undefined;
    let referenceReads: string[] = [];
    if (this.sessionDir) {
      const applied = await applyUserMessageWorkspaceLock({
        sessionDir: this.sessionDir,
        sessionId: this.sessionId,
        userMessage: plainUserText,
      });
      lockedWorkspaceRoot = applied.state.lockedRoot;
      referenceReads = applied.state.referenceReads;
      if (applied.detection.changeNotice) {
        messages.push({ role: 'user', content: applied.detection.changeNotice });
      }
      if (lockedWorkspaceRoot) {
        this.workspaceRoot = lockedWorkspaceRoot;
      }
    }

    const deps = this.buildRunDeps();
    deps.workspaceRoot = this.workspaceRoot;
    deps.lockedWorkspaceRoot = lockedWorkspaceRoot;
    deps.referenceReads = referenceReads;

    const tools = this.contextAssembler.getTools();
    logger.loopStart(tools.length, messages.length);

    const sessionGoalAnchor = resolveSessionGoalAnchor(
      userMessage,
      messages,
      activeCheckpoint?.userGoal,
    );

    this.memoryIntegration.onLoopStart(
      sessionGoalAnchor,
      {
        chat: async (msgs, opts) => chatFn(msgs, { tools: [], ...opts }),
        stream: async () => { throw new Error('Stream not supported for memory sideQuery'); },
        countTokens: async (text) => estimateStringTokens(text),
      },
    );

    const state: HarnessRunState = {
      messages,
      tools,
      turnCount: 0,
      maxOutputTokensRecoveryCount: 0,
      llmRetryCount: 0,
      emptyResponseRetryCount: 0,
      consecutiveToolFailures: 0,
      consecutiveReadOnlyRounds: 0,
      noToolExecutionRecoveryCount: 0,
      taskSwitchInjected: false,
      stopHookContinuationCount: 0,
      verificationGateContinuationCount: 0,
      transition: 'initial',
      justCompacted: false,
      amnesiaRecoveryCount: 0,
      reasoningOnlyRecoveryCount: 0,
      prematureCompletionRecoveryCount: 0,
      taskState: new TaskState(sessionGoalAnchor),
      repoContext: new RepoContext(),
      runtimeStateHash: '',
      lockedWorkspaceRoot,
      referenceReads,
      workspaceAnchorHash: '',
      failedToolCallSignatures: new Map(),
      branchBudget: this.resilienceV2Enabled ? new BranchBudgetTracker() : undefined,
      branchBudgetWarnedThisRound: false,
      verificationDigestInjectedThisRound: false,
      rebuildEscalationInjections: 0,
      rebuildEscalationInjectedThisRound: false,
      parallelBudgetBlockHintInjected: false,
      segmentRenewalCount: 0,
      sessionGoalAnchor,
      buildDiagnosticGateActive: false,
      verificationOutputBuffer: new VerificationOutputBuffer(),
      taskAcceptance: new TaskAcceptanceTracker(sessionGoalAnchor),
      consecutiveNoToolRounds: 0,
      missingFileAttempts: new Map(),
      harnessPolicyStats: emptyHarnessPolicyStats(),
      checkpointResumeForkApplied: false,
      contextEmergencyCompactUsed: false,
      stepReviewedThisRound: false,
      executionMode: 'free',
      executionModeLockRemaining: 0,
      executionModeEnteredBy: [],
      pendingModeSignals: [],
      forcedTaskBearingRoundsSinceEntry: 0,
      supervisorPhase: 'free',
      recoveryPendingSticky: false,
      stableRoundsSinceLastFailure: 0,
      filesChangedAtRoundStart: 0,
      branchSwitchedThisRound: false,
      // L2-6：让 resilience save 与 after-round 钩子能通过 state 访问 bridge，无需再串依赖链。
      supervisorBridge: this.supervisorBridge,
    };
    state.submitModeSignal = (source, signal, payload) => this.submitModeSignal(state, source, signal, payload);
    syncExecutionModeLoopState(this.loopController, state);
    // F1 / §2.8 / T12 — 仅当 ModeDecisionEngine 启用时才让 ExecutionMode 控制
    // BranchBudget / CheckpointEngine forced policy；OFF 模式保持子模块原 always-on 行为，
    // 避免 ExecutionMode 接入回归掉原 Resilience v2 的分支预算保护。
    if (this.globalPolicy?.modeDecisionEngineEnabled) {
      this.applyExecutionModeGates(state, state.executionMode ?? 'free');
    }

    if (this.resilienceV2Enabled && this.checkpointEngine) {
      try {
        const v2 = await this.checkpointEngine.loadV2();
        if (v2) {
          state.branchBudget?.applySnapshot(v2.branchBudget);
          state.rebuildEscalationInjections = v2.rebuildEscalationInjections ?? 0;
          state.parallelBudgetBlockHintInjected = v2.parallelBudgetBlockHintInjected ?? false;
          // W8: 恢复 supervisor 历史承载位（observability only），
          //     真正的 enter forced 仍由下方 checkpoint_resumed signal 驱动 ModeDecisionEngine 裁决；
          //     这样既能保留 enteredBy / forcedDegradedTier 等历史，又不绕过 I5 单写约束。
          if (v2.supervisorState) {
            const supervisor = v2.supervisorState;
            // W8: 历史承载位只用于 observability（telemetry / UI 上下文），
            //     真正的 enter forced 仍由下方 submit('checkpoint_resumed') 驱动 ModeDecisionEngine 裁决；
            //     不直接复写 sticky，避免 resume 后 forced 永远无法 exit 的死锁。
            state.executionModeEnteredBy = [...(supervisor.executionModeEnteredBy ?? [])];
            state.executionModeEnteredByPrimary = supervisor.executionModeEnteredByPrimary;
            state.executionModeEnteredAtRound = supervisor.executionModeEnteredAtRound ?? undefined;
            state.forcedDegradedTier = supervisor.forcedDegradedTier;
            state.forcedTaskBearingRoundsSinceEntry = supervisor.forcedTaskBearingRoundsSinceEntry ?? 0;
            state.lastModeDecision = supervisor.lastModeDecision;
            // L2-6 / T08：把 supervisorPhase + RecoverySupervisor 内部快照 + timeline tail + I4 budget
            //              推回 bridge；bridge 自身会写 `failure:checkpoint_resumed` timeline 标记。
            state.supervisorPhase = supervisor.supervisorPhase ?? state.supervisorPhase;
            state.segmentRenewalCount = supervisor.segmentRenewalCount ?? 0;
            this.supervisorBridge?.restoreFromCheckpoint(supervisor);
          }
          state.verificationOutputBuffer.restore(v2.verificationOutputTail);
          if (v2.acceptanceGate?.active) {
            if (state.taskAcceptance) {
              state.taskAcceptance.restore(v2.acceptanceGate);
            } else {
              state.taskAcceptance = TaskAcceptanceTracker.fromSnapshot(v2.acceptanceGate);
            }
            syncTaskVerificationFromAcceptance(state.taskState, state.taskAcceptance);
          }
          state.submitModeSignal?.('checkpoint_engine', 'checkpoint_resumed');
          const pending = this.checkpointEngine.pendingRecoverySignals();
          if (pending.length > 0) {
            for (const sig of pending) {
              messages.push({ role: 'user', content: sig.message });
            }
            this.checkpointEngine.markRecoverySignalsConsumed(s => !s.consumed);
          }
        }
      } catch (err) {
        console.debug(
          '[harness] resilience v2 load failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (existingMessages && existingMessages.length > 0) {
      try {
        const hydrated = await this.memoryIntegration.hydrateRuntimeFromSessionNotes(
          state.taskState,
          state.repoContext,
        );
        if (hydrated) {
          state.sessionGoalAnchor = syncHydratedTaskState(
            userMessage,
            messages,
            state.taskState,
            state.repoContext,
            state.sessionGoalAnchor,
          );
          onStep?.({
            type: 'memory_event',
            memoryKind: 'session_hydrate',
            memoryDetail: '已从会话笔记恢复任务与仓库状态',
          });
        }
      } catch (err) {
        console.debug(
          '[harness] session-notes 运行时恢复失败:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (activeCheckpoint) {
      const resumeSummary = this.checkpointManager!.buildResumeMessage(activeCheckpoint);
      state.activeCheckpointResumeSummary = resumeSummary;
      if (existingMessages && existingMessages.length > 0) {
        const est = this.contextCompactor.getEstimatedTokens(messages);
        const forkThreshold = Math.floor(readCompactionContextWindowTokens() * 0.5);
        if (existingMessages.length >= 60 || est > forkThreshold) {
          const fork = applyCheckpointResumeFork(this.contextCompactor, messages, resumeSummary);
          state.checkpointResumeForkApplied = true;
          console.log(
            `[harness] checkpoint resume fork: ${fork.beforeMessages}→${fork.afterMessages} msgs | `
            + `~estCtxTok ${fork.beforeTokens}→${fork.afterTokens}`,
          );
          deps.runtimeTelemetry?.recordCompaction({
            beforeMessages: fork.beforeMessages,
            afterMessages: fork.afterMessages,
            beforeTokens: fork.beforeTokens,
            afterTokens: fork.afterTokens,
          });
        } else {
          const filtered = stripResumeCheckpointMessages(messages);
          messages.length = 0;
          messages.push(...filtered, resumeSummary);
        }
      } else {
        messages.push(resumeSummary);
      }

      const refreshedAnchor = resolveSessionGoalAnchor(
        userMessage,
        messages,
        activeCheckpoint.userGoal,
      );
      if (!isPoisonedGoal(refreshedAnchor)) {
        state.sessionGoalAnchor = refreshedAnchor;
        if (isPoisonedGoal(state.taskState.snapshot().goal)) {
          state.taskState.rebindGoal(refreshedAnchor);
        }
      }
    }

    try {
      while (true) {
        const prep = await prepareHarnessRound(deps, {
          state,
          userMessage,
          chatFn,
          logger,
          onStep,
          streamFn,
        });
        if (prep.action === 'stop') return prep.result;

        this.evaluateExecutionModeBeforeLlm(deps, state, prep.round, onStep);

        const toolsForLlm = resolveLlmToolsForRound(state.tools, prep.round, plainUserText);

        const llm = await callHarnessLlm(deps, {
          state,
          normalizedMsgs: prep.normalizedMsgs,
          currentTools: toolsForLlm,
          round: prep.round,
          chatFn,
          streamFn,
          logger,
          onStep,
        });
        if (llm.action === 'retry') continue;
        if (llm.action === 'abort') {
          return handleHarnessStop(deps, {
            reason: 'user_abort',
            messages: state.messages,
            chatFn,
            tools: state.tools,
            logger,
            onStep,
            streamFn,
            runtimeState: state,
          });
        }
        if (llm.action === 'error') return llm.result;

        const { response: rawResponse, llmRoundLog, tokenUsage } = llm;
        const response = salvageTextToolCallsInResponse(rawResponse);
        if (response.toolCalls?.length && !rawResponse.toolCalls?.length) {
          console.log(`[harness] 从 assistant 文本抢救 ${response.toolCalls.length} 个 tool_call`);
        }
        const hasToolCalls = !!response.toolCalls?.length;

        if (!hasToolCalls) {
          logger.llmResponseFinal(llmRoundLog.usage, llmRoundLog.meta);
          const noTools = await handleNoToolCalls(deps, {
            state,
            response,
            userMessage,
            currentTools: state.tools,
            tokenUsage,
            logger,
            onStep,
          });
          if (noTools.action === 'continue') continue;
          return noTools.result;
        }

        logger.llmResponseToolCalls(response.toolCalls!.length, llmRoundLog.usage, llmRoundLog.meta);
        const toolRound = await runHarnessToolRound(deps, {
          state,
          response,
          userMessage,
          currentTools: state.tools,
          round: prep.round,
          tokenUsage,
          chatFn,
          logger,
          onStep,
          streamFn,
        });
        if (toolRound.action === 'return') return toolRound.result;
      }
    } finally {
      this.memoryIntegration.onLoopEnd(
        state.messages,
        state.turnCount,
        this.loopController.getState().totalInputTokens,
        { task: state.taskState.snapshot(), repo: state.repoContext.snapshot() },
      ).catch(err => {
        console.debug('[harness] memory onLoopEnd failed:', err instanceof Error ? err.message : err);
      });
    }
  }

  getLoopState() {
    return this.loopController.getState();
  }

  getStopHookManager(): StopHookManager {
    return this.stopHookManager;
  }

  flushExtractionNotices(): string[] {
    return this.memoryIntegration.flushExtractionNotices();
  }

  async drainMemory(timeoutMs: number = 10_000): Promise<void> {
    await this.memoryIntegration.drain(timeoutMs);
    this.memoryIntegration.dispose();
  }
}

/**
 * §19.6 — L2 观察活跃时 free 段不重复 inject supervisor 侧 C 类 recovery（branch recover、
 * rebuild escalation、verification digest 等）。
 * 连续工具失败阶梯（轻提示/证据包/强警告）不受此开关影响，始终经 lifecycle source 注入。
 */
export function shouldSuppressObserverInject(policy: GlobalModePolicy | undefined): boolean {
  if (!policy) return false;
  return policy.observerEnabled && policy.recoverySupervisorEnabled;
}

/**
 * L2-6 — TaskRiskLevel → [0,1] 启发式映射。
 *
 * 与 `SupervisorParams.adaptiveFree.riskThreshold`（默认 0.6）相对：
 *   - L0_observation → 0.2（远低于阈值）
 *   - L1_minor_edit  → 0.5（贴近但低于阈值）
 *   - L2_structural  → 0.7（跨阈值，成为候选）
 *
 * V2 可由 RiskEvaluator 用更细致权重替换；本映射只是 V1 启发式占位。
 */
function riskScoreFromLevel(level: ReturnType<TaskRiskClassifier['classify']>): number {
  switch (level) {
    case 'L2_structural':
      return 0.7;
    case 'L1_minor_edit':
      return 0.5;
    case 'L0_observation':
    default:
      return 0.2;
  }
}
