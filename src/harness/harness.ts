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
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  ChatFunction,
  StreamFunction,
} from './types.js';
import { ContextAssembler } from './context-assembler.js';
import { LoopController } from './loop-controller.js';
import { ContextCompactor, type CompactionConfig } from './context-compactor.js';
import { HarnessLogger } from './logger.js';
import { StopHookManager } from './stop-hooks.js';
import { TokenBudgetTracker } from './token-budget.js';
import { HarnessMemoryIntegration } from './harness-memory.js';
import { TaskState } from './task-state.js';
import { RepoContext } from './repo-context.js';
import { TaskCheckpointManager } from './checkpoint.js';
import { RuntimeTelemetry } from './runtime-telemetry.js';
import { BranchBudgetTracker } from './branch-budget.js';
import { CheckpointEngine, isResilienceV2Enabled } from './checkpoint-engine.js';
import { GraphExecutor } from './task-graph-executor.js';
import { ensureDelegateToSubagentTool } from './sub-agent-runner.js';
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

/** run() 内各子模块共享的运行时依赖（由 Harness 实例字段组装）。 */
export type HarnessRunDeps = RoundPrepDeps & ToolExecutorDeps & {
  stopHookManager: StopHookManager;
  tokenBudgetTracker?: TokenBudgetTracker;
  abortSignal?: AbortSignal;
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
  private onConfirm?: HarnessConfig['onConfirm'];
  private memoryIntegration: HarnessMemoryIntegration;
  private abortSignal?: AbortSignal;
  private checkpointManager?: TaskCheckpointManager;
  private checkpointPersistTail = Promise.resolve();
  private graphExecutor: GraphExecutor;
  private runtimeTelemetry?: RuntimeTelemetry;
  private workspaceRoot: string;
  private resilienceV2Enabled: boolean;
  private checkpointEngine?: CheckpointEngine;
  private globalPolicy?: HarnessConfig['globalPolicy'];
  private supervisorConfig?: HarnessConfig['supervisorConfig'];

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
    this.onConfirm = config.onConfirm;
    this.abortSignal = config.loop.signal;
    this.workspaceRoot = config.workspaceRoot ?? process.cwd();
    this.globalPolicy = config.globalPolicy;
    this.supervisorConfig = config.supervisorConfig;
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
      onConfirm: this.onConfirm,
      workspaceRoot: this.workspaceRoot,
      tokenBudgetTracker: this.tokenBudgetTracker,
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
    const deps = this.buildRunDeps();

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
    if (activeCheckpoint) {
      messages.push(this.checkpointManager!.buildResumeMessage(activeCheckpoint));
    }
    const tools = this.contextAssembler.getTools();
    logger.loopStart(tools.length, messages.length);

    this.memoryIntegration.onLoopStart(
      userMessage,
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
      transition: 'initial',
      justCompacted: false,
      amnesiaRecoveryCount: 0,
      taskState: new TaskState(userMessage),
      repoContext: new RepoContext(),
      runtimeStateHash: '',
      failedToolCallSignatures: new Map(),
      branchBudget: this.resilienceV2Enabled ? new BranchBudgetTracker() : undefined,
      branchBudgetWarnedThisRound: false,
      stepReviewedThisRound: false,
    };

    if (this.resilienceV2Enabled && this.checkpointEngine) {
      try {
        const v2 = await this.checkpointEngine.loadV2();
        if (v2) {
          state.branchBudget?.applySnapshot(v2.branchBudget);
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

        const llm = await callHarnessLlm(deps, {
          state,
          normalizedMsgs: prep.normalizedMsgs,
          currentTools: state.tools,
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

        const { response, llmRoundLog, tokenUsage } = llm;
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
