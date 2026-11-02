/**
 * Harness — 核心循环引擎（状态机模式）。
 *
 * 使用 while(true) + 可变 State 对象的迭代模式，
 * 避免深度递归导致的栈溢出。
 *
 * 每轮迭代：
 * 1. 消息预处理（上下文压缩 → 发送管道封存/易变注入）
 * 2. 调用 LLM
 * 3. 处理响应
 * 4. 决定 continue / stop
 *
 * state.transition 记录每次 continue 的原因，方便调试和测试。
 */

import type { UnifiedMessage } from '../llm/types.js';
import { estimateStringTokens } from '../llm/token-estimator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import { clearReadBeforeEditScope } from '../tools/read-before-edit.js';
import type {
  ChatFunction,
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';
import { ContextAssembler } from './context-assembler.js';
import { LoopController, MAX_LOOP_ITERATIONS_WITHOUT_LLM } from './loop-controller.js';
import { ContextCompactor, type CompactionConfig } from './context-compactor.js';
import { buildTotalTokenUsageWithContext } from './context-usage-display.js';
import { applyCheckpointResumeFork, stripResumeCheckpointMessages } from './checkpoint-resume-compact.js';
import { readCompactionContextWindowTokens } from './context-window-tier.js';
import { HarnessLogger } from './logger.js';
import { StopHookManager } from './stop-hooks.js';
import { TokenBudgetTracker } from './token-budget.js';
import { HarnessMemoryIntegration } from './harness-memory.js';
import { TaskState } from './task-state.js';
import { RepoContext } from './repo-context.js';
import { resolveSessionGoalAnchor, isPoisonedGoal } from './session-goal-anchor.js';
import { isFreshQueryMessage, syncHydratedTaskState } from './resume-task-state.js';
import { VerificationOutputBuffer } from './verification-output-buffer.js';
import { OperationOutcomeLedger } from './operation-outcome.js';
import { CompletionFactsView } from './completion-facts-view.js';
import { emptyHarnessPolicyStats } from './harness-policy-stats.js';
import { TaskCheckpointManager } from './checkpoint.js';
import { RuntimeTelemetry, SUB_AGENT_TELEMETRY_LIMITS } from './runtime-telemetry.js';
import { CheckpointEngine } from './checkpoint-engine.js';
import { emitLightweightSnapshotBoundary } from './checkpoint-snapshot.js';
import { ensureTaskTool, stripTaskTool } from './agents/task-tool.js';
import { AgentAwareToolExecutor } from './agents/agent-tool-executors.js';
import { DEFAULT_AGENT_MAX_OUTPUT_TOKENS } from '../config/model-capabilities.js';
import {
  CHECKPOINT_RESUME_FORK_MIN_MESSAGES,
  CHECKPOINT_RESUME_FORK_TOKEN_RATIO,
  DEFAULT_COMPACTION_KEEP_RECENT,
  DEFAULT_COMPACTION_THRESHOLD,
} from './harness-constants.js';
import type { HarnessRunState } from './harness-run-state.js';
import { callHarnessLlm, type LlmCallDeps } from './harness-llm-call.js';
import { prepareHarnessRound, type RoundPrepDeps } from './harness-round-prep.js';
import { handleNoToolCalls, type NoToolRoundDeps } from './harness-round-no-tools.js';
import { runHarnessToolRound, type ToolRoundDeps } from './harness-tool-round.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import { runWithWorkspaceTouchScope } from './workspace-command-touch.js';
import { finalizeMessagesForApi } from './context-assembler.js';
import { releaseLegacyToolBudgetSeals } from './harness-message-budget.js';
import {
  resolveVerificationExemptDirPrefixes,
  setVerificationExemptRuntime,
  runWithVerificationExemptScope,
} from './verification-exempt-config.js';
import { resolveSalvagedLlmResponse } from './text-tool-call-salvage.js';
import { resolveVerificationPlan } from './verification-plan.js';
import {
  createVerificationRuntimeState,
  sanitizeVerificationRuntimeState,
  syncVerificationWorkspaceMutation,
} from './verification-state.js';
import { applyUserMessageWorkspaceLock } from './session-workspace-store.js';
import { isPlausibleWorkspaceRoot } from './workspace-lock.js';
import {
  dumpHarnessTiming,
  endTiming,
  markTimingStart,
  resetHarnessTiming,
  runWithHarnessTimingScope,
  timeAsync,
  timeSync,
} from './harness-timing.js';

/**
 * 一次 run 里各阶段看到的依赖。底层是同一份字段，类型按阶段收窄，
 * 调用方不用再凑一个交叉类型。
 */
interface HarnessPhaseDeps {
  prep: RoundPrepDeps;
  llm: LlmCallDeps;
  tools: ToolRoundDeps;
  noTools: NoToolRoundDeps;
}

type SharedRunDeps = RoundPrepDeps & LlmCallDeps & ToolRoundDeps & NoToolRoundDeps;

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
  private onShellMandatoryConfirm?: HarnessConfig['onShellMandatoryConfirm'];
  private shellCollabActive: boolean;
  private planModeActive: boolean;
  private skipCompletionGate: boolean;
  private memoryIntegration: HarnessMemoryIntegration;
  private abortSignal?: AbortSignal;
  private checkpointManager?: TaskCheckpointManager;
  private checkpointPersistTail = Promise.resolve();
  private runtimeTelemetry?: RuntimeTelemetry;
  /** 构造时的默认工作区；工作区锁只覆盖单次 run，不回写此字段 */
  private readonly workspaceRoot: string;
  private sessionDir?: string;
  private sessionId: string;
  private checkpointEngine?: CheckpointEngine;
  private verificationExemptDirs?: string[];
  private agentMaxOutputTokens: number;
  private readonly config: HarnessConfig;

  /**
   * 根据 HarnessConfig 组装循环所需子模块：上下文、压缩、工具执行、检查点、记忆等。
   */
  constructor(
    config: HarnessConfig,
    toolExecutor: ToolExecutor,
  ) {
    const context = {
      ...config.context,
      tools: config.agentSpawner
        ? ensureTaskTool(config.context.tools, config.agentSpawner.agentTypes)
        : stripTaskTool(config.context.tools),
    };
    this.config = config;
    this.contextAssembler = new ContextAssembler(context);
    this.loopController = new LoopController(config.loop);
    this.agentMaxOutputTokens = config.loop.maxOutputTokens ?? DEFAULT_AGENT_MAX_OUTPUT_TOKENS;
    this.sessionId = config.sessionId ?? 'default';
    const compactionPartial: Partial<CompactionConfig> = {
      threshold: config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
      tokenThreshold: config.compactionTokenThreshold,
      keepRecent: config.compactionKeepRecent ?? DEFAULT_COMPACTION_KEEP_RECENT,
      enableLLMSummary: config.compactionEnableLLMSummary,
      sessionId: this.sessionId,
      sessionDir: config.sessionDir,
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
    this.onShellMandatoryConfirm = config.onShellMandatoryConfirm;
    this.shellCollabActive = config.shellCollabActive === true;
    this.planModeActive = config.planModeActive === true;
    this.skipCompletionGate = config.skipCompletionGate === true;
    this.abortSignal = config.loop.signal;
    this.workspaceRoot = config.workspaceRoot ?? process.cwd();
    this.verificationExemptDirs = config.verificationExemptDirs;
    this.sessionDir = config.sessionDir;
    this.checkpointManager = config.sessionDir
      ? new TaskCheckpointManager(config.sessionDir, config.sessionId)
      : undefined;
    this.runtimeTelemetry = new RuntimeTelemetry(
      config.sessionDir,
      config.sessionId,
      config.agentScope ? SUB_AGENT_TELEMETRY_LIMITS : undefined,
    );

    if (config.sessionDir) {
      this.checkpointEngine = new CheckpointEngine(config.sessionDir, config.sessionId);
    }

    this.memoryIntegration = new HarnessMemoryIntegration({
      memoryDir: config.memoryDir,
      fileMemoryManager: config.fileMemoryManager,
      sessionDir: config.sessionDir,
      sessionId: config.sessionId,
      workspaceRoot: config.workspaceRoot,
      disabled: config.memoryDisabled === true,
    });

    if (config.loop.tokenBudget) {
      this.tokenBudgetTracker = new TokenBudgetTracker({
        totalBudget: config.loop.tokenBudget,
      });
    }
  }

  /** 把本实例上的子模块引用按阶段视图交出去。各视图指向同一对象，工作区锁改动能一起看见。 */
  private buildPhaseDeps(): HarnessPhaseDeps {
    const shared: SharedRunDeps = {
      loopController: this.loopController,
      contextCompactor: this.contextCompactor,
      memoryIntegration: this.memoryIntegration,
      runtimeTelemetry: this.runtimeTelemetry,
      checkpointManager: this.checkpointManager,
      enqueueCheckpointPersist: (task) => this.enqueueCheckpointPersist(task),
      checkpointEngine: this.checkpointEngine,
      stopHookManager: this.stopHookManager,
      toolExecutor: this.toolExecutor,
      permissionRules: this.permissionRules ?? [],
      skipPermissionChecks: this.skipPermissionChecks,
      onConfirm: this.onConfirm,
      onShellMandatoryConfirm: this.onShellMandatoryConfirm,
      shellCollabActive: this.shellCollabActive,
      planModeActive: this.planModeActive,
      skipCompletionGate: this.skipCompletionGate,
      ephemeralSystemContext: this.contextAssembler.buildEphemeralSystemContextMessage(),
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      sessionDir: this.sessionDir,
      tokenBudgetTracker: this.tokenBudgetTracker,
      agentMaxOutputTokens: this.agentMaxOutputTokens,
      abortSignal: this.abortSignal,
      checkpointOwner: this.config.checkpointOwner,
      agentScope: this.config.agentScope,
    };
    return { prep: shared, llm: shared, tools: shared, noTools: shared };
  }

  /**
   * 将 checkpoint / resilience v2 的磁盘写入串行化，避免并发 run 或并行工具轮互相覆盖。
   * 无 checkpointManager 且无 checkpointEngine 时直接执行 task，不加队列。
   */
  enqueueCheckpointPersist<T>(task: () => Promise<T>): Promise<T> {
    if (!this.checkpointManager && !this.checkpointEngine) {
      return task();
    }
    const run = () => task();
    const p = this.checkpointPersistTail.then(run, run);
    this.checkpointPersistTail = p.then(
      (): void => { },
      (): void => { },
    );
    return p;
  }

  /**
   * 执行核心 while 循环：prep → LLM → 无工具/有工具分支 → 直至 stop。
   * 负责会话初始化、工作区锁定、检查点/resilience 恢复、记忆 hydrate，并在 finally 中收尾记忆写入。
   */
  async run(
    userMessage: string,
    chatFn: ChatFunction,
    onStep?: (event: HarnessStepEvent) => void,
    existingMessages?: UnifiedMessage[],
    streamFn?: StreamFunction,
    userContentBlocks?: import('../llm/types.js').ContentBlock[],
  ): Promise<HarnessResult> {
    // 每次 run 建立独立的「验收豁免」运行时作用域（AsyncLocalStorage），
    // 使并发会话各自隔离，互不覆盖（P1-10）。
    return runWithVerificationExemptScope(() =>
      runWithHarnessTimingScope(() =>
        runWithWorkspaceTouchScope(() =>
          this.runScoped(userMessage, chatFn, onStep, existingMessages, streamFn, userContentBlocks),
        ),
      ),
    );
  }

  private async runScoped(
    userMessage: string,
    chatFn: ChatFunction,
    onStep?: (event: HarnessStepEvent) => void,
    existingMessages?: UnifiedMessage[],
    streamFn?: StreamFunction,
    userContentBlocks?: import('../llm/types.js').ContentBlock[],
  ): Promise<HarnessResult> {
    const { logger, phases, state, memoryActive, runStartedAt } = await this.restoreRunState(
      userMessage,
      chatFn,
      onStep,
      existingMessages,
      streamFn,
      userContentBlocks,
    );

    try {
      this.loopController.resetForNewRun();
      endTiming('run_init', runStartedAt);
      while (true) {
        this.loopController.noteLoopIteration();
        if (this.loopController.isStalled()) {
          logger.error(`连续 ${MAX_LOOP_ITERATIONS_WITHOUT_LLM} 次循环未拿到模型响应，判定停滞并中断`);
          return handleHarnessStop(phases.prep, {
            reason: 'error',
            messages: state.messages,
            chatFn,
            tools: state.tools,
            logger,
            onStep,
            streamFn,
            runtimeState: state,
            finalContent: [
              `任务停滞，已自动中断：连续 ${MAX_LOOP_ITERATIONS_WITHOUT_LLM} 次循环都没有成功调用模型（多为上下文压缩或重试在空转）。`,
              '已完成的修改都保留着。发送「继续」会从当前进度接着做；若反复出现，请新开会话。',
            ].join('\n'),
          });
        }
        const roundStartedAt = markTimingStart();
        const prep = await timeAsync('round_prep', () => prepareHarnessRound(phases.prep, {
          state,
          userMessage,
          chatFn,
          logger,
          onStep,
          streamFn,
        }));
        if (prep.action === 'stop') {
          endTiming('round_wall', roundStartedAt);
          return prep.result;
        }
        emitLightweightSnapshotBoundary({
          boundary: 'round_started',
          sessionId: this.sessionId,
          round: prep.round,
        });

        timeSync('context_usage', () => {
          onStep?.({
            type: 'context_usage',
            iteration: prep.round,
            totalTokenUsage: buildTotalTokenUsageWithContext(state.messages, state.tools, {
              lastInputTokens: phases.llm.loopController.getState().lastInputTokens,
              lastOutputTokens: phases.llm.loopController.getState().lastOutputTokens,
            }),
          });
        }, prep.round);

        const toolsForLlm = state.tools;

        const llm = await callHarnessLlm(phases.llm, {
          state,
          normalizedMsgs: prep.normalizedMsgs,
          currentTools: toolsForLlm,
          round: prep.round,
          chatFn,
          streamFn,
          logger,
          onStep,
        });
        if (llm.action === 'retry') {
          endTiming('round_wall', roundStartedAt, prep.round);
          continue;
        }
        if (llm.action === 'abort') {
          endTiming('round_wall', roundStartedAt, prep.round);
          return handleHarnessStop(phases.prep, {
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
        if (llm.action === 'error') {
          endTiming('round_wall', roundStartedAt, prep.round);
          return llm.result;
        }

        const { response: rawResponse, llmRoundLog, tokenUsage } = llm;
        const response = timeSync(
          'post_salvage',
          () => resolveSalvagedLlmResponse(rawResponse, new Set(toolsForLlm.map(t => t.name))),
          prep.round,
        );
        if (response.toolCalls?.length && !rawResponse.toolCalls?.length) {
          console.log(`[harness] 从 assistant 文本抢救 ${response.toolCalls.length} 个 tool_call`);
        }
        const hasToolCalls = !!response.toolCalls?.length;

        if (!hasToolCalls) {
          logger.llmResponseFinal(llmRoundLog.usage, llmRoundLog.meta);
          const noTools = await timeAsync('post_no_tools', () => handleNoToolCalls(phases.noTools, {
            state,
            response,
            rawAssistantContent: rawResponse.content,
            userMessage,
            currentTools: state.tools,
            tokenUsage,
            logger,
            onStep,
          }), prep.round);
          if (noTools.action === 'continue') {
            endTiming('round_wall', roundStartedAt, prep.round);
            continue;
          }
          endTiming('round_wall', roundStartedAt, prep.round);
          return noTools.result;
        }

        logger.llmResponseToolCalls(response.toolCalls!.length, llmRoundLog.usage, llmRoundLog.meta);
        const toolRound = await timeAsync('tool_round', () => runHarnessToolRound(phases.tools, {
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
        }), prep.round);
        endTiming('round_wall', roundStartedAt, prep.round);
        if (toolRound.action === 'return') return toolRound.result;

        // 工具轮后不 graph-stop：让下一轮 LLM 生成正文，再由 D′ 统一收尾。
      }
    } finally {
      endTiming('run_total', runStartedAt);
      dumpHarnessTiming();
      if (memoryActive) {
        this.memoryIntegration.onLoopEnd(
          state.messages,
          state.turnCount,
          this.loopController.getState().totalInputTokens,
          { task: state.taskState.snapshot(), repo: state.repoContext.snapshot() },
          { stopReason: this.loopController.getState().stopReason },
        ).catch(err => {
          console.debug('[harness] memory onLoopEnd failed:', err instanceof Error ? err.message : err);
        });
      }
    }
  }


  /**
   * 一次 run 开始前的会话恢复：消息、工作区锁、checkpoint / 记忆 hydrate。
   * 是否沿用旧任务只判断一次，避免锚点和 V3 恢复各算一遍。
   */
  private async restoreRunState(
    userMessage: string,
    chatFn: ChatFunction,
    onStep: ((event: HarnessStepEvent) => void) | undefined,
    existingMessages: UnifiedMessage[] | undefined,
    streamFn: StreamFunction | undefined,
    userContentBlocks: import('../llm/types.js').ContentBlock[] | undefined,
  ): Promise<{
    logger: HarnessLogger;
    phases: HarnessPhaseDeps;
    state: HarnessRunState;
    memoryActive: boolean;
    runStartedAt: number;
  }> {
    const logger = new HarnessLogger();
    resetHarnessTiming();
    const runStartedAt = markTimingStart();
    onStep?.({ type: 'execution_plan_clear' });

    let messages: UnifiedMessage[];
    const messageContent = userContentBlocks ?? userMessage;
    if (existingMessages && existingMessages.length > 0) {
      messages = finalizeMessagesForApi(existingMessages.slice());
      releaseLegacyToolBudgetSeals(messages);
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
    const projectCheckpoint = this.checkpointManager
      ? await this.checkpointManager.loadProject()
      : null;
    const activeCheckpoint = projectCheckpoint
      ? this.checkpointManager?.toActiveCheckpoint(projectCheckpoint) ?? null
      : null;

    const plainUserText = userMessage;
    let workspaceRoot = this.workspaceRoot;
    let lockedWorkspaceRoot: string | undefined;
    let referenceReads: string[] = [];
    if (this.config.workspaceLock) {
      lockedWorkspaceRoot = this.config.workspaceLock.lockedRoot;
      referenceReads = [...this.config.workspaceLock.referenceReads];
    } else if (this.sessionDir) {
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
      if (lockedWorkspaceRoot && isPlausibleWorkspaceRoot(lockedWorkspaceRoot)) {
        workspaceRoot = lockedWorkspaceRoot;
      }
    }

    clearReadBeforeEditScope(workspaceRoot, this.sessionId);

    const exemptPrefixes = await resolveVerificationExemptDirPrefixes({
      workspaceRoot,
      globalDirs: this.verificationExemptDirs,
      mainConfigPath: process.env.ICE_CONFIG_PATH,
    });
    setVerificationExemptRuntime({
      workspaceRoot,
      prefixes: exemptPrefixes,
    });

    const phases = this.buildPhaseDeps();
    phases.tools.workspaceRoot = workspaceRoot;
    phases.tools.lockedWorkspaceRoot = lockedWorkspaceRoot;
    phases.tools.referenceReads = referenceReads;
    const spawner = this.config.agentSpawner;
    if (spawner) {
      spawner.beginParentRun();
      const parentToolExecutor = this.toolExecutor;
      const timeout = this.config.loop.timeout;
      const deadline = timeout && timeout > 0 ? Date.now() + timeout : undefined;
      phases.tools.toolExecutor = new AgentAwareToolExecutor(
        parentToolExecutor,
        (toolCall) =>
          spawner.runTask(toolCall, {
            config: this.config,
            toolExecutor: parentToolExecutor,
            workspaceRoot,
            lockedWorkspaceRoot,
            referenceReads,
            deadline,
            signal: this.abortSignal,
            onStep,
          }),
        (toolCall) => spawner.runCheckAgent(toolCall),
      );
      phases.tools.agentSpawner = spawner;
    }

    const tools = this.contextAssembler.getTools();
    logger.loopStart(tools.length, messages.length);

    const resumePersistedTask = projectCheckpoint != null
      && !isFreshQueryMessage(userMessage, projectCheckpoint.execution.taskState.goal);
    const persistedGoalForAnchor = resumePersistedTask && projectCheckpoint
      ? projectCheckpoint.execution.taskState.goal
      : activeCheckpoint?.userGoal;
    const sessionGoalAnchor = resolveSessionGoalAnchor(
      userMessage,
      messages,
      persistedGoalForAnchor,
    );
    const verificationPlanResolution = await resolveVerificationPlan({
      goal: sessionGoalAnchor,
      workspaceRoot,
      onWarning: warning => {
        console.debug(
          `[harness] verification plan ${warning.kind} (${warning.source}):`,
          warning.message,
        );
      },
    });

    const memoryActive = !this.shellCollabActive && this.config.memoryDisabled !== true;
    if (memoryActive) {
      this.memoryIntegration.onLoopStart(
        sessionGoalAnchor,
        {
          chat: async (msgs, opts) => chatFn(msgs, { usageSource: 'memory_recall', tools: [], ...opts }),
          stream: async () => { throw new Error('Stream not supported for memory sideQuery'); },
          countTokens: async (text) => estimateStringTokens(text),
        },
        { triggerUserMessage: userMessage, messages: [...messages] },
      );
    }

    const state: HarnessRunState = {
      messages,
      tools,
      turnCount: 0,
      maxOutputTokensRecoveryCount: 0,
      llmRetryCount: 0,
      emptyResponseRetryCount: 0,
      consecutiveToolFailures: 0,
      hadToolRoundThisRun: false,
      noToolExecutionRecoveryCount: 0,
      runStartedAt: Date.now(),
      taskSwitchInjected: false,
      stopHookContinuationCount: 0,
      transition: 'initial',
      justCompacted: false,
      amnesiaRecoveryCount: 0,
      reasoningOnlyRecoveryCount: 0,
      taskState: new TaskState(sessionGoalAnchor),
      repoContext: new RepoContext(),
      runtimeStateHash: '',
      lockedWorkspaceRoot,
      referenceReads,
      workspaceAnchorHash: '',
      failedToolCallSignatures: new Map(),
      sessionGoalAnchor,
      verificationOutputBuffer: new VerificationOutputBuffer(),
      operationOutcomes: new OperationOutcomeLedger(),
      verificationPlanResolution,
      verificationState: createVerificationRuntimeState(),
      missingFileAttempts: new Map(),
      shellMandatoryConfirmDenials: new Set(),
      harnessPolicyStats: emptyHarnessPolicyStats(),
      checkpointResumeForkApplied: false,
      contextEmergencyCompactUsed: false,
      contextEmergencyCompactCount: 0,
    };

    if (this.checkpointEngine) {
      try {
        await this.checkpointEngine.loadV2();
      } catch (err) {
        console.debug(
          '[harness] resilience v2 load failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Verification output buffers do not cross user turns.
    state.verificationOutputBuffer.clear();

    if (memoryActive && existingMessages && existingMessages.length > 0) {
      try {
        const hydrated = await this.memoryIntegration.hydrateRuntimeFromSessionNotes(
          state.taskState,
          state.repoContext,
          { completionAuthority: projectCheckpoint ? 'checkpoint' : 'legacy-notes' },
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

    // V3 is the authoritative runtime snapshot. Session notes above remain a legacy,
    // read-only source for narrative/repo continuity and cannot replace V3 completion.
    if (resumePersistedTask && projectCheckpoint) {
      const completion = CompletionFactsView.fromCompletionSnapshot(projectCheckpoint.completion);
      state.taskState.applySnapshot(projectCheckpoint.execution.taskState);
      state.repoContext.applySnapshot(projectCheckpoint.workspace.repoContext);
      state.operationOutcomes?.replace(projectCheckpoint.completion.operationOutcomes);
      state.verificationState = sanitizeVerificationRuntimeState(
        projectCheckpoint.completion.verificationState,
      );
      syncVerificationWorkspaceMutation(state.verificationState, state.taskState);
      state.restoredCompletionConditions = completion.conditionSnapshot();
      state.completionGateBlockingSignature = projectCheckpoint.completion.blockingSignature;
      state.completionStatus = projectCheckpoint.completion.status;
      state.completionReason = projectCheckpoint.completion.reason;
      state.failedToolCallSignatures = new Map(
        Object.entries(projectCheckpoint.execution.resumable?.failedToolCallSignatures ?? {}),
      );
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
        memoryDetail: '已从 V3 checkpoint 恢复执行与完成状态',
      });
    }

    if (activeCheckpoint) {
      const resumeSummary = this.checkpointManager!.buildResumeMessage(activeCheckpoint);
      state.activeCheckpointResumeSummary = resumeSummary;
      if (existingMessages && existingMessages.length > 0) {
        const est = this.contextCompactor.getEstimatedTokens(messages);
        const forkThreshold = Math.floor(
          readCompactionContextWindowTokens() * CHECKPOINT_RESUME_FORK_TOKEN_RATIO,
        );
        if (existingMessages.length >= CHECKPOINT_RESUME_FORK_MIN_MESSAGES || est > forkThreshold) {
          const fork = applyCheckpointResumeFork(this.contextCompactor, messages, resumeSummary);
          state.checkpointResumeForkApplied = true;
          console.log(
            `[harness] checkpoint resume fork: ${fork.beforeMessages}→${fork.afterMessages} msgs | `
            + `~estCtxTok ${fork.beforeTokens}→${fork.afterTokens}`,
          );
          phases.prep.runtimeTelemetry?.recordCompaction({
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

    return { logger, phases, state, memoryActive, runStartedAt };
  }

  /** 返回 LoopController 的累计轮次、token 用量等统计，供外部 UI 或测试观测。 */
  getLoopState() {
    return this.loopController.getState();
  }

  /** 暴露 StopHook 管理器，供路由层注册「停止后继续」等钩子。 */
  getStopHookManager(): StopHookManager {
    return this.stopHookManager;
  }

  /** 取出并清空记忆子系统在循环中积累的提取提示，通常在一次 run 结束后由调用方展示。 */
  flushExtractionNotices(): string[] {
    return this.memoryIntegration.flushExtractionNotices();
  }

  /** 等待记忆后台任务在超时内完成，然后释放 memoryIntegration 资源。 */
  async drainMemory(timeoutMs: number = 10_000): Promise<void> {
    await this.memoryIntegration.drain(timeoutMs);
    this.memoryIntegration.dispose();
  }
}

