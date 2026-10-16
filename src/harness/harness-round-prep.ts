import type { UnifiedMessage } from '../llm/types.js';
import { buildMessagesForLlm } from './harness-api-messages.js';
import { shouldApplyCasualHarness } from './casual-mode.js';
import type { CompactionDeps } from './harness-compaction.js';
import { maybeCompact } from './harness-compaction.js';
import { takeBgStatusForInjection } from './harness-bg-summary.js';
import { formatBackgroundInjection } from './agents/agent-background-hub.js';
import { mergeAgentFileChanges } from './agents/agent-merge.js';
import type { AgentSpawner } from './agents/agent-spawner.js';
import {
  bigramJaccard,
  getLastAssistantText,
  getLatestRealUserText,
  getPreviousRealUserText,
  isActionableToolRequest,
  isSystemInjectedUserContent,
} from './harness-message-utils.js';
import { appendQueuedAlsoNotesToMessages } from '../session/pending-note.js';
import { TASK_SWITCH_JACCARD_THRESHOLD } from './harness-constants.js';
import { shouldSkipMemoryRecallOnPostForkRound } from './checkpoint-resume-compact.js';
import {
  hasTopicShifted,
  type HarnessMemoryIntegration,
  type InjectMemoryMode,
} from './harness-memory.js';
import { isResumeContinuationMessage } from './resume-goal.js';
import { prepareRuntimeContextEphemeral } from './harness-runtime-inject.js';
import { prepareWorkspaceAnchorEphemeral } from './workspace-anchor.js';
import type { StopHandlerDeps } from './harness-stop-handler.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import { buildToolPlan, formatToolPlan } from './tool-planner.js';
import type { RuntimeTelemetry } from './runtime-telemetry.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';
import { timeAsync, timeSync } from './harness-timing.js';
export interface RoundPrepDeps extends CompactionDeps, StopHandlerDeps {
  loopController: LoopController;
  memoryIntegration: HarnessMemoryIntegration;
  runtimeTelemetry?: RuntimeTelemetry;
  /** 后台摘要注入用；缺省 'default'。和 workspaceRoot 一起决定 BackgroundTaskManager 实例。 */
  sessionId?: string;
  /** 后台摘要 / 工具 cwd 锚点；ToolExecutorDeps 已要求必填，这里冗余声明便于 prep 单独使用。 */
  workspaceRoot?: string;
  /** 当前用户轮次的易变工具/MCP 上下文；仅进入发送视图，不写主历史。 */
  ephemeralSystemContext?: string | null;
  /** 后台子 Agent：每轮开始时取走已完成报告并注入（与「后台 Agent：N 运行中」状态）。 */
  agentSpawner?: AgentSpawner;
}

export interface PrepareHarnessRoundArgs {
  state: HarnessRunState;
  userMessage: string;
  chatFn: ChatFunction;
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  streamFn?: StreamFunction;
}

export type PrepareHarnessRoundResult =
  | { action: 'continue'; normalizedMsgs: UnifiedMessage[]; round: number }
  | { action: 'stop'; result: HarnessResult };

/** 用户在问以前记下的约定、偏好或配置。普通「上次测试失败」不算。 */
export function asksAboutRememberedContext(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /(记得|还记得|回忆).{0,16}(约定|偏好|配置|规则|习惯|怎么)|上次怎么|以前怎么|我的偏好|项目约定|remember (my|our|the).{0,24}(preference|convention|config)/i.test(trimmed);
}

/**
 * 闲聊走轻量召回。执行任务默认关键词，避免精排堵住下一轮主模型。
 * 话题切换或明确在问记忆时才走标准召回。
 */
export function resolveRecallInjectMode(args: {
  casual: boolean;
  hadToolRoundThisRun: boolean;
  topicShifted?: boolean;
  asksMemory?: boolean;
}): InjectMemoryMode {
  if (args.casual) return 'casual_light';
  if (args.asksMemory || args.topicShifted) return 'default';
  return 'coarse_pre_llm';
}

const TASK_SWITCH_NOTICE_EXCERPT_CHARS = 400;

/**
 * 只拿本轮用户原文和上一条助手回复比。
 * 历史里后写入的失败证据、自检、验收摘要不能变成「新任务」。
 */
export function shouldInjectUnrelatedTaskNotice(
  userMessage: string,
  lastAssistantText: string,
): boolean {
  const latest = userMessage.trim();
  if (!latest || !lastAssistantText.trim()) return false;
  if (isSystemInjectedUserContent(latest)) return false;
  if (isResumeContinuationMessage(latest)) return false;
  return bigramJaccard(latest, lastAssistantText) < TASK_SWITCH_JACCARD_THRESHOLD;
}

/** 点明本轮用户原文。没有可引用的用户句子时，不得把工具调用或诊断块当成新任务。 */
export function buildUnrelatedTaskNotice(userMessage: string): string {
  const excerpt = userMessage.trim().replace(/\s+/g, ' ').slice(0, TASK_SWITCH_NOTICE_EXCERPT_CHARS);
  return [
    '[System: The user message that started this run does not overlap the previous assistant reply. Follow that user message. Do not invent a different task.]',
    `User message: ${excerpt}`,
    'Runtime diagnostics, tool failures, and your own earlier tool calls are not a new request. If this user message still refers to the current work, continue that work.',
  ].join('\n');
}

/**
 * 轮次预处理：压缩、推进轮次、运行时注入、记忆、工具规划、规范化与预算、任务切换检测。
 */
export async function prepareHarnessRound(
  deps: RoundPrepDeps,
  args: PrepareHarnessRoundArgs,
): Promise<PrepareHarnessRoundResult> {
  const { state, userMessage, chatFn, logger, onStep, streamFn } = args;
  const { messages: msgs, tools: currentTools } = state;

  const alsoNotes = appendQueuedAlsoNotesToMessages(msgs, deps.sessionId ?? 'default');
  for (const entry of alsoNotes) {
    const anchor = state.sessionGoalAnchor?.trim();
    const supplement = entry.text.trim();
    if (supplement) {
      state.sessionGoalAnchor = anchor ? `${anchor}\n\n${supplement}` : supplement;
      state.taskState.rebindGoal(state.sessionGoalAnchor);
    }
  }

  await timeAsync('prep_compact', () => maybeCompact(deps, {
    messages: msgs,
    chatFn,
    logger,
    onStep,
    state,
    lastApiPromptTokens: deps.loopController.getState().lastInputTokens,
    tools: currentTools,
  }));

  deps.loopController.advanceRound();
  state.turnCount++;
  const round = deps.loopController.getState().currentRound;
  logger.roundStart(round, msgs.length);
  deps.runtimeTelemetry?.recordRound({
    round,
    task: state.taskState.snapshot(),
    repo: state.repoContext.snapshot(),
  });

  const loopStop = deps.loopController.shouldContinue();
  if (loopStop) {
    return {
      action: 'stop',
      result: await handleHarnessStop(deps, {
        reason: loopStop,
        messages: msgs,
        chatFn,
        tools: currentTools,
        logger,
        onStep,
        streamFn,
        runtimeState: state,
      }),
    };
  }

  logger.llmCall();

  const ephemeralBlocks: string[] = [];
  if (deps.ephemeralSystemContext) {
    ephemeralBlocks.push(deps.ephemeralSystemContext);
  }
  const runtimeContext = prepareRuntimeContextEphemeral(state);
  if (runtimeContext) ephemeralBlocks.push(runtimeContext);

  const workspaceAnchor = prepareWorkspaceAnchorEphemeral(state);
  if (workspaceAnchor) ephemeralBlocks.push(workspaceAnchor);

  // 后台任务摘要：running 5min 节流；任意终态 dirty 立即注入。启动 ≠ 通过，由模型看 exit。
  if (deps.workspaceRoot) {
    const sessionId = deps.sessionId ?? 'default';
    const bgStatus = takeBgStatusForInjection(sessionId, deps.workspaceRoot);
    if (bgStatus) {
      ephemeralBlocks.push(bgStatus);
    }
  }

  // 后台子 Agent：把已完成、尚未注入的报告发给模型，并把改动并入父状态，避免主 Agent 对后台结果失忆。
  if (deps.agentSpawner) {
    const drained = deps.agentSpawner.drainBackgroundResults();
    if (drained.length > 0) {
      for (const item of drained) {
        const outcome = deps.agentSpawner.takeOutcome(item.toolCallId);
        if (outcome) mergeAgentFileChanges(item.toolCallId, outcome, state);
      }
      ephemeralBlocks.push(formatBackgroundInjection(drained));
    }
    const live = deps.agentSpawner
      .listBackgroundViews()
      .filter(v => v.status === 'running' || v.status === 'queued');
    if (live.length > 0) {
      ephemeralBlocks.push(
        `[Background Agents] ${live.length} sub-agent(s) still running: `
        + `${live.map(v => `${v.agentId} (${v.type}) ${v.description}`).join('; ')}. `
        + 'Use check_agent to fetch their results.',
      );
    }
  }

  {
    const intent = state.taskState.snapshot().intent;
    const skipMemoryRecall = shouldSkipMemoryRecallOnPostForkRound(state);
    if (!skipMemoryRecall) {
      const latestUser = getLatestRealUserText(msgs, userMessage);
      const memoryMode = resolveRecallInjectMode({
        casual: shouldApplyCasualHarness(intent),
        hadToolRoundThisRun: state.hadToolRoundThisRun === true,
        topicShifted: hasTopicShifted(getPreviousRealUserText(msgs, latestUser), latestUser),
        asksMemory: asksAboutRememberedContext(latestUser),
      });
      await timeAsync('prep_memory', () =>
        deps.memoryIntegration.injectMemoryContext(msgs, { mode: memoryMode, onStep }),
      );
    }
  }

  if (
    state.turnCount === 1
    && currentTools.length > 0
    && isActionableToolRequest(getLatestRealUserText(msgs, userMessage))
    && !shouldApplyCasualHarness(state.taskState.snapshot().intent)
  ) {
    ephemeralBlocks.push(
      formatToolPlan(
        buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot()),
      ),
    );
  }

  if (!state.taskSwitchInjected && shouldInjectUnrelatedTaskNotice(userMessage, getLastAssistantText(msgs))) {
    msgs.push({
      role: 'user',
      content: buildUnrelatedTaskNotice(userMessage),
    });
    state.taskSwitchInjected = true;
  }

  const normalizedMsgs = timeSync('prep_build_msgs', () =>
    buildMessagesForLlm(msgs, { blocks: ephemeralBlocks }),
  );

  if (deps.loopController.isAborted()) {
    return {
      action: 'stop',
      result: await handleHarnessStop(deps, {
        reason: 'user_abort',
        messages: msgs,
        chatFn,
        tools: currentTools,
        logger,
        onStep,
        streamFn,
        runtimeState: state,
      }),
    };
  }

  return { action: 'continue', normalizedMsgs, round };
}
