import type { UnifiedMessage } from '../llm/types.js';
import type { ContextCompactor } from './context-compactor.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import {
  PRE_COMPACT_SESSION_MEMORY_WAIT_MS,
  PRE_COMPACT_SESSION_TIMEOUT_MSG,
} from './harness-constants.js';
import type { HarnessRunState } from './harness-run-state.js';
import { shouldSkipCompactionOnPostForkRound } from './checkpoint-resume-compact.js';
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
}

/**
 * 如果需要，执行上下文压缩（参考 claude-code 的压缩策略）。
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

  // ── 第一道防线：轻量微压缩
  if (deps.contextCompactor.needsMicroCompaction(messages) && !deps.contextCompactor.needsCompaction(messages)) {
    const before = messages.length;
    const beforeTok = deps.contextCompactor.getEstimatedTokens(messages);
    const compacted = deps.contextCompactor.doLightCompact(messages);
    messages.length = 0;
    messages.push(...compacted);
    const afterTok = deps.contextCompactor.getEstimatedTokens(messages);
    console.log(`[harness] 微压缩: ${before} → ${messages.length} 条消息 (纯本地，零 LLM 成本)`);
    logger.compaction(before, messages.length, beforeTok, afterTok);
    onStep?.({ type: 'compaction', content: `micro: ${before} → ${messages.length}` });
    return; // 微压缩不注入恢复提示，对 LLM 透明
  }

  // ── 第二道防线：硬压缩 ──
  if (!deps.contextCompactor.needsCompaction(messages)) return;

  const before = messages.length;
  const beforeTokens = deps.contextCompactor.getEstimatedTokens(messages);

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
    const compacted = deps.contextCompactor.compactWithSessionMemory(messages, sessionNotes);
    messages.length = 0;
    messages.push(...compacted);
  } else {
    const compacted = await deps.contextCompactor.compact(messages, chatFn);
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
      messages.splice(
        messages.length - Math.min(deps.contextCompactor.getConfig().keepRecent, messages.length),
        0,
        ...recentMemoryMessages,
      );
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
}
