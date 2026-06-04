import type { ToolDefinition, UnifiedMessage } from '../llm/types.js';
import { resolveCompactionUsage } from '../llm/token-estimator.js';
import type { CompactRunOptions, ContextCompactor } from './context-compactor.js';
import type { CompactionUsageOptions } from './context-compactor.js';
import {
  MICRO_COMPACTION_RATIO,
  MICRO_MIN_SAVINGS_RATIO,
  PROACTIVE_FORK_RATIO,
} from './compaction-constants.js';
import {
  applyCheckpointResumeFork,
  buildEmergencyResumeSummaryMessage,
  shouldSkipCompactionOnPostForkRound,
} from './checkpoint-resume-compact.js';
import { readEffectiveContextWindowTokens } from './context-window-tier.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import {
  PRE_COMPACT_SESSION_MEMORY_WAIT_MS,
  PRE_COMPACT_SESSION_TIMEOUT_MSG,
} from './harness-constants.js';
import { buildTotalTokenUsageWithContext } from './context-usage-display.js';
import { applyToolResultBudget } from './harness-message-budget.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import { resilienceSaveCheckpoint } from './harness-resilience.js';
import type { HarnessLogger } from './logger.js';
import type { RuntimeTelemetry } from './runtime-telemetry.js';
import type { ChatFunction, HarnessStepEvent } from './types.js';

export interface CompactionDeps extends ResilienceBridgeDeps {
  contextCompactor: ContextCompactor;
  memoryIntegration: HarnessMemoryIntegration;
  runtimeTelemetry?: RuntimeTelemetry;
}

export interface MaybeCompactArgs {
  messages: UnifiedMessage[];
  chatFn: ChatFunction;
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  state?: HarnessRunState;
  /** 上一轮 API 报告的 prompt_tokens */
  lastApiPromptTokens?: number;
  tools?: ToolDefinition[];
}

function buildUsageOptions(args: MaybeCompactArgs): CompactionUsageOptions {
  return {
    lastApiPromptTokens: args.lastApiPromptTokens ?? 0,
    tools: args.tools ?? args.state?.tools,
  };
}

function applyProactiveForkIfNeeded(
  deps: CompactionDeps,
  messages: UnifiedMessage[],
  state: HarnessRunState | undefined,
  tools: ToolDefinition[] | undefined,
  logger: HarnessLogger,
  usageOptions: CompactionUsageOptions,
  onStep?: (event: HarnessStepEvent) => void,
): boolean {
  if (!state || state.contextEmergencyCompactUsed) return false;

  const ctxWindow = readEffectiveContextWindowTokens();
  const proactiveLine = Math.floor(ctxWindow * PROACTIVE_FORK_RATIO);
  const usage = resolveCompactionUsage({
    messages,
    tools,
    lastApiPromptTokens: usageOptions.lastApiPromptTokens ?? 0,
  });
  if (usage.effectiveUsed < proactiveLine) return false;

  state.contextEmergencyCompactUsed = true;
  state.checkpointResumeForkApplied = true;
  const summary = buildEmergencyResumeSummaryMessage(state.activeCheckpointResumeSummary);
  const fork = applyCheckpointResumeFork(deps.contextCompactor, messages, summary, { aggressive: true });
  console.log(
    `[harness] 主动收缩: effectiveUsed=${usage.effectiveUsed} ≥ ${proactiveLine} `
    + `(${fork.beforeMessages}→${fork.afterMessages} msgs)`,
  );
  logger.compaction(fork.beforeMessages, fork.afterMessages, fork.beforeTokens, fork.afterTokens);
  deps.runtimeTelemetry?.recordCompaction({
    beforeMessages: fork.beforeMessages,
    afterMessages: fork.afterMessages,
    beforeTokens: fork.beforeTokens,
    afterTokens: fork.afterTokens,
  });
  onStep?.({ type: 'compaction', content: `proactive: ${fork.beforeMessages} → ${fork.afterMessages}` });
  state.justCompacted = true;
  state.amnesiaRecoveryCount = 0;
  emitContextUsageStep(onStep, messages, tools);
  return true;
}

function emitContextUsageStep(
  onStep: MaybeCompactArgs['onStep'],
  messages: UnifiedMessage[],
  tools: ToolDefinition[] | undefined,
): void {
  onStep?.({
    type: 'context_usage',
    totalTokenUsage: buildTotalTokenUsageWithContext(messages, tools, { localOnly: true }),
  });
}

/**
 * 如果需要，执行上下文压缩
 *
 * 两条路径：
 * 1. 会话记忆可用 → compactWithSessionMemory（0 LLM 成本）
 * 2. 会话记忆不可用 → compact（1 次 LLM 调用）
 *
 * 压缩后统一恢复：
 * - 重新注入最近读过的文件内容
 * - 保留最近注入的记忆消息
 * - 注入恢复指引
 */
export async function maybeCompact(
  deps: CompactionDeps,
  args: MaybeCompactArgs,
): Promise<void> {
  const { messages, chatFn, logger, onStep, state } = args;

  if (state && shouldSkipCompactionOnPostForkRound(state)) {
    return;
  }

  applyToolResultBudget(messages);
  deps.contextCompactor.resetMicroCompactRound();

  const usageOptions = buildUsageOptions(args);
  const tools = usageOptions.tools;
  const usage = resolveCompactionUsage({ messages, ...usageOptions });

  const needsHard = deps.contextCompactor.needsCompaction(messages, usageOptions);
  const needsMicro = deps.contextCompactor.needsMicroCompaction(messages, usageOptions);
  let mustHardCompact = needsHard;

  if (!needsHard && !needsMicro) return;

  // ── 第一道防线：轻量微压缩（未达硬压缩线时）
  if (needsMicro && !needsHard && deps.contextCompactor.canMicroCompact()) {
    const before = messages.length;
    const beforeEffective = usage.effectiveUsed;
    const compacted = deps.contextCompactor.doLightCompact(messages);
    messages.length = 0;
    messages.push(...compacted);

    const postLocalOptions: CompactionUsageOptions = { tools, lastApiPromptTokens: 0 };
    const afterUsage = resolveCompactionUsage({ messages, ...postLocalOptions });
    const postDualUsage = resolveCompactionUsage({ messages, ...usageOptions });
    const saved = beforeEffective - afterUsage.effectiveUsed;
    const needsHardAfter = deps.contextCompactor.needsCompaction(messages, usageOptions);
    const weakMicro = saved < beforeEffective * MICRO_MIN_SAVINGS_RATIO;
    const microThreshold = Math.floor(readEffectiveContextWindowTokens() * MICRO_COMPACTION_RATIO);

    if (!needsHardAfter && !weakMicro && postDualUsage.effectiveUsed < microThreshold) {
      const afterTok = deps.contextCompactor.getEstimatedTokens(messages);
      console.log(
        `[harness] 微压缩: ${before} → ${messages.length} 条消息 `
        + `(effective ${beforeEffective}→${afterUsage.effectiveUsed}, 纯本地)`,
      );
      logger.compaction(before, messages.length, beforeEffective, afterTok);
      onStep?.({ type: 'compaction', content: `micro: ${before} → ${messages.length}` });
      applyProactiveForkIfNeeded(deps, messages, state, tools, logger, usageOptions, onStep);
      if (!state?.contextEmergencyCompactUsed) {
        emitContextUsageStep(onStep, messages, tools);
      }
      return;
    }
    // 节省不足 / 双轨仍触线 / 本地仍触线 → 同轮升档硬压缩
    mustHardCompact = true;
  } else if (!needsHard) {
    return;
  }

  // ── 第二道防线：硬压缩 ──
  const stillNeedsHard = mustHardCompact
    || deps.contextCompactor.needsCompaction(messages, usageOptions);
  if (!stillNeedsHard) {
    applyProactiveForkIfNeeded(deps, messages, state, tools, logger, usageOptions, onStep);
    return;
  }

  const hardRunOptions: CompactRunOptions = {
    usageOptions,
    forceFullCompact: mustHardCompact,
  };

  const before = messages.length;
  const beforeTokens = deps.contextCompactor.getEffectiveUsed(messages, usageOptions);

  // 压缩前备份任务目标到会话笔记：等待完成后再读盘，避免与硬压缩读到旧笔记竞态（带超时降级）
  const taskDesc = deps.contextCompactor.getTaskDescription(messages);
  if (taskDesc) {
    const waitMs = PRE_COMPACT_SESSION_MEMORY_WAIT_MS;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(PRE_COMPACT_SESSION_TIMEOUT_MSG)), waitMs);
    });
    try {
      await Promise.race([
        deps.memoryIntegration.maybeUpdateSessionMemory(
          messages,
          0,
          true,
          state
            ? { task: state.taskState.snapshot(), repo: state.repoContext.snapshot() }
            : undefined,
        ),
        timeoutPromise,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === PRE_COMPACT_SESSION_TIMEOUT_MSG) {
        console.log(
          `[harness] 压缩前会话笔记更新超时（>${waitMs}ms），使用磁盘上现有内容继续压缩`,
        );
      } else {
        console.debug('[harness] 压缩前等待会话笔记更新失败:', msg);
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  // 压缩前获取会话笔记
  const sessionNotes = await deps.memoryIntegration.getSessionMemoryForCompact();

  // 压缩前保存最近注入的记忆消息
  const recentMemoryMessages: UnifiedMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && recentMemoryMessages.length < 3; i--) {
    const rawContent = messages[i].content;
    const content: string = typeof rawContent === 'string' ? rawContent : '';
    if (content.startsWith('<system-reminder>') && content.includes('Recalled Memories')) {
      recentMemoryMessages.unshift(messages[i]);
      break;
    }
  }

  // 压缩前提取最近文件内容（压缩后会丢失）
  const recentFileContents = deps.contextCompactor.extractRecentFileContents(messages);
  const runtimeRecoveryContext = state
    ? deps.contextCompactor.buildRuntimeRecoveryContext(
      state.taskState.snapshot(),
      state.repoContext.snapshot(),
    )
    : null;

  // ── 压缩 ──
  if (sessionNotes) {
    const compacted = deps.contextCompactor.compactWithSessionMemory(
      messages,
      sessionNotes,
      hardRunOptions,
    );
    messages.length = 0;
    messages.push(...compacted);
  } else {
    const compacted = await deps.contextCompactor.compact(messages, chatFn, undefined, hardRunOptions);
    messages.length = 0;
    messages.push(...compacted);
  }

  // ── 压缩后统一恢复 ──

  // 1. 重新注入最近记忆消息（如果被压缩掉了）
  if (recentMemoryMessages.length > 0) {
    const hasMemoryInCompacted = messages.some(m => {
      const c = typeof m.content === 'string' ? m.content : '';
      return c.startsWith('<system-reminder>') && c.includes('Recalled Memories');
    });
    if (!hasMemoryInCompacted) {
      // 插在 system 之后、recent 尾段之前；勿用 length-keepRecent（短消息时会变成 0，把记忆插到 system 前 → MiniMax 400）
      let insertAt = 0;
      while (insertAt < messages.length && messages[insertAt].role === 'system') {
        insertAt++;
      }
      const keepRecent = deps.contextCompactor.getConfig().keepRecent;
      if (keepRecent > 0 && messages.length > insertAt) {
        insertAt = Math.max(insertAt, messages.length - keepRecent);
      }
      messages.splice(insertAt, 0, ...recentMemoryMessages);
    }
  }

  // 2. 重新注入 Runtime State + Repo Context（压缩恢复优先上下文）
  if (runtimeRecoveryContext) {
    messages.push(runtimeRecoveryContext);
  }

  // 3. 重新注入最近文件内容
  if (recentFileContents.length > 0) {
    messages.push(...recentFileContents);
  }

  // 4. 注入恢复指引（使用新的多重恢复提示）
  const recentUserMsgs: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recentUserMsgs.length < 3; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.length > 50) {
      recentUserMsgs.unshift(msg.content);
    }
  }
  messages.push(deps.contextCompactor.buildRecoveryPrompt(recentUserMsgs, !!sessionNotes));

  // 5. 设置压缩标记（用于后续失忆检测）
  if (state) {
    state.justCompacted = true;
    state.amnesiaRecoveryCount = 0;
  }

  const afterTokCompact = deps.contextCompactor.getEstimatedTokens(messages);
  logger.compaction(before, messages.length, beforeTokens, afterTokCompact);
  deps.runtimeTelemetry?.recordCompaction({
    beforeMessages: before,
    afterMessages: messages.length,
    beforeTokens,
    afterTokens: afterTokCompact,
  });
  onStep?.({ type: 'compaction', content: `${before} → ${messages.length}` });
  await resilienceSaveCheckpoint(deps, 'compaction', state);

  emitContextUsageStep(onStep, messages, tools);
  applyProactiveForkIfNeeded(
    deps,
    messages,
    state,
    tools,
    logger,
    { tools, lastApiPromptTokens: 0 },
    onStep,
  );
}
