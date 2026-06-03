/**
 * 上下文压缩器 — 参考 claude-code 的分层策略。
 *
 * 压缩触发（写死常量，见 compaction-constants.ts）：
 * - 硬压缩：effectiveUsed ≥ contextWindow × 0.85，或剩余 < 18K
 * - 微压缩：effectiveUsed ≥ contextWindow × 0.72（且未达硬压缩线）
 * - effectiveUsed = max(本地 messages + tools schema 估算, 上一轮 API prompt_tokens)
 *
 * 两条压缩路径：
 * - 会话记忆路径（compactWithSessionMemory）：0 LLM 成本，会话记忆作为摘要
 * - LLM 路径（compact）：五层递进，可选 LLM 精炼
 *
 * 五层压缩：
 * 1. snip — 裁剪冗余段落（重复的 system-reminder、context-summary、compact_boundary、recent-dialogue-focus）
 * 2. microcompact — 压缩旧工具调用细节（硬压缩路径）；微压缩（doLightCompact）侧清空白名单工具的过时正文，不删短 user
 * 3. toolResultTrim — 裁剪超长工具结果（文件操作上限 15K 字符）
 * 4. structuralExtract — 从被删消息提取结构化摘要（不调 LLM）
 * 5. llmSummarize — 用 LLM 精炼摘要（可选，会话记忆路径跳过）
 *
 * 压缩后恢复：
 * - extractRecentFileContents：重新注入最近读过的文件内容
 * - buildRecoveryPrompt：注入恢复指引（"直接继续，不要重复"）
 *
 * 最近消息保留使用 token 预算（≥10K token, ≥5 条消息, ≤40K token）。
 */

import type { ToolDefinition, UnifiedMessage } from '../llm/types.js';
import { finalizeMessagesForApi } from './context-assembler.js';
import { prepareAssistantContentForHistory } from './text-format-tool-call-parsers.js';
import { estimateMessagesTokens, resolveCompactionUsage } from '../llm/token-estimator.js';
import type { ChatFunction } from './types.js';
import type { TaskStateSnapshot, RepoContextSnapshot } from '../types/runtime-snapshot.js';
import type { CompactBoundaryMeta } from './compaction-strategy.js';
import {
  applyLightMicrocompactToolClear,
  buildCompactBoundaryContent,
  buildRecentDialogueFocusContent,
  FILE_TOOLS_PRESERVE_FULL_OUTPUT,
  isSyntheticUserBlockContent,
  shouldPreserveMessageOnCompaction,
  truncateSessionNotesForCompact,
} from './compaction-strategy.js';
import {
  findCheckpointAnchorIndex,
  isResumeCheckpointContent,
  stripResumeCheckpointMessages,
} from './checkpoint-resume-compact.js';
import { readCompactionContextWindowTokens, readEffectiveContextWindowTokens } from './context-window-tier.js';
import {
  COMPACTION_RESERVE_TOKENS,
  HARD_COMPACTION_RATIO,
  MICRO_COMPACTION_RATIO,
  MICRO_MAX_PER_ROUND,
  MICRO_MAX_PER_SESSION,
} from './compaction-constants.js';

/** 去掉 recent 前缀中无前置 assistant(tool_calls) 的孤立 tool 消息（fork 切片可能留下）。 */
function trimLeadingOrphanToolMessages(recent: UnifiedMessage[]): UnifiedMessage[] {
  let start = 0;
  while (start < recent.length && recent[start]?.role === 'tool') {
    start++;
  }
  return start > 0 ? recent.slice(start) : recent;
}

/** 压缩判定时可选的双轨占用输入 */
export interface CompactionUsageOptions {
  lastApiPromptTokens?: number;
  tools?: ToolDefinition[];
}

/** {@link compact} / {@link compactWithSessionMemory} 运行时选项 */
export interface CompactRunOptions {
  usageOptions?: CompactionUsageOptions;
  /** 双轨/API 已判定需硬压缩：跳过层间本地-only 早退，split 无丢弃时强制摘要 */
  forceFullCompact?: boolean;
}

/**
 * 压缩配置。
 */
export interface CompactionConfig {
  /** 触发压缩的消息数量阈值（向后兼容） */
  threshold: number;
  /** 触发压缩的估算 token 阈值（优先于 threshold）。默认动态计算：contextWindow × ratio */
  tokenThreshold?: number;
  /** 压缩后保留的最近消息数上限 */
  keepRecent: number;
  /** 保留最近消息的最小 token 数（参考 claude-code: 10000） */
  keepRecentMinTokens: number;
  /** 保留最近消息的最大 token 数（参考 claude-code: 40000） */
  keepRecentMaxTokens: number;
  /** 保留最近消息的最小条数 */
  keepRecentMinMessages: number;
  /** 单个工具结果的最大字符数 */
  maxToolResultLength: number;
  /** 是否启用 LLM 摘要（需要在 compact 时传入 chatFn） */
  enableLLMSummary?: boolean;
  /** 硬压缩后再注入的 read_file 结果最多保留几条唯一路径（构造时钳制在 1–64，默认 12 与历史行为一致） */
  maxReinjectFiles: number;
  /** 重新注入最近文件内容的总 token 预算 */
  maxReinjectTokens: number;
  /** 会话 id，用于压缩截断提示中的 session-notes 路径 */
  sessionId?: string;
}

/** 用户消息内容长度超过此阈值时强制保留，防止任务描述被压缩丢弃 */
const MIN_USER_MSG_LENGTH_TO_PRESERVE = 200;

/** 简短用户消息阈值：长度低于此值的确认消息在轻量压缩中可丢弃 */
const SHORT_USER_MSG_MAX_LENGTH = 50;

/** 硬分割后缀中至少保留的非注入 user 条数（对齐 round-safe） */
const MIN_REAL_USERS_IN_SUFFIX = 2;

/**
 * 读取上下文窗口大小（委托 {@link readEffectiveContextWindowTokens}）。
 */
function getContextWindow(): number {
  return readEffectiveContextWindowTokens();
}

const DEFAULT_CONFIG: CompactionConfig = {
  threshold: 40,
  keepRecent: 40,
  keepRecentMinTokens: 10000,
  keepRecentMaxTokens: 40000,
  keepRecentMinMessages: 5,
  maxToolResultLength: 3000,
  enableLLMSummary: true,
  maxReinjectFiles: 12,
  maxReinjectTokens: 50000,
};

/** 再注入唯一文件数上限（构造参数钳制） */
const MIN_REINJECT_FILES_CAP = 1;
const MAX_REINJECT_FILES_CAP = 64;

/**
 * 估算消息列表的 token 数。
 * 委托给统一的 token-estimator，保持向后兼容的导出。
 */
export function estimateTokens(messages: UnifiedMessage[]): number {
  return estimateMessagesTokens(messages);
}

/**
 * ContextCompactor 管理对话历史的压缩，防止 token 溢出。
 */
export class ContextCompactor {
  private config: CompactionConfig;
  /** 微压缩会话计数（单会话最多 MICRO_MAX_PER_SESSION 次） */
  private microCompactSessionCount = 0;
  /** 微压缩本轮计数（每轮 prep 最多 MICRO_MAX_PER_ROUND 次） */
  private microCompactRoundCount = 0;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.tokenThreshold ??= Math.floor(getContextWindow() * HARD_COMPACTION_RATIO);
    const reinjectCap = this.config.maxReinjectFiles;
    this.config.maxReinjectFiles =
      typeof reinjectCap === 'number' &&
      Number.isFinite(reinjectCap) &&
      reinjectCap >= MIN_REINJECT_FILES_CAP
        ? Math.min(Math.floor(reinjectCap), MAX_REINJECT_FILES_CAP)
        : DEFAULT_CONFIG.maxReinjectFiles;
  }

  /** 每轮 prep 开始时重置本轮微压缩计数 */
  resetMicroCompactRound(): void {
    this.microCompactRoundCount = 0;
  }

  /** 是否仍可执行微压缩（会话 + 本轮配额） */
  canMicroCompact(): boolean {
    return this.microCompactSessionCount < MICRO_MAX_PER_SESSION
      && this.microCompactRoundCount < MICRO_MAX_PER_ROUND;
  }

  private resolveEffectiveUsed(messages: UnifiedMessage[], options?: CompactionUsageOptions): number {
    return resolveCompactionUsage({
      messages,
      tools: options?.tools,
      lastApiPromptTokens: options?.lastApiPromptTokens,
    }).effectiveUsed;
  }

  /**
   * 检查是否需要轻量微压缩（在硬压缩之前）。
   * 微压缩在 72% 有效占用时触发，纯本地操作，零 LLM 成本。
   */
  needsMicroCompaction(messages: UnifiedMessage[], options?: CompactionUsageOptions): boolean {
    if (!this.canMicroCompact()) return false;
    const ctxWindow = getContextWindow();
    const effectiveUsed = this.resolveEffectiveUsed(messages, options);
    const microThreshold = Math.floor(ctxWindow * MICRO_COMPACTION_RATIO);
    return effectiveUsed >= microThreshold;
  }

  /**
   * 执行轻量微压缩（预防层）。
   *
   * 纯本地操作，不调用 LLM：
   * - **不丢弃**短 user（B：避免误伤导航/确认句）
   * - 对「白名单」内、超过最近 5 个 tool-calling assistant 轮的工具结果，清空正文为占位 stub（节省 token）
   * 微压缩后不注入恢复提示，对 LLM 近似透明。
   */
  doLightCompact(messages: UnifiedMessage[]): UnifiedMessage[] {
    this.microCompactSessionCount++;
    this.microCompactRoundCount++;

    let assistantRound = 0;
    const msgAssistantRound = new Map<number, number>();
    const toolCallIdToName = new Map<string, string>();

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && m.toolCalls?.length) {
        assistantRound++;
        for (const tc of m.toolCalls) {
          toolCallIdToName.set(tc.id, tc.name);
        }
      }
      msgAssistantRound.set(i, assistantRound);
    }

    return applyLightMicrocompactToolClear(messages, {
      keepLastAssistantToolRounds: 5,
      toolCallIdToName,
      msgAssistantRound,
      currentAssistantRound: assistantRound,
    });
  }

  /**
   * 检查是否需要硬压缩（双重校验）。
   *
   * 条件：
   * 1. effectiveUsed 达到 tokenThreshold（默认 contextWindow × 0.85），或
   * 2. 剩余空间不足 COMPACTION_RESERVE_TOKENS token
   */
  needsCompaction(messages: UnifiedMessage[], options?: CompactionUsageOptions): boolean {
    const ctxWindow = getContextWindow();
    const effectiveUsed = this.resolveEffectiveUsed(messages, options);
    const remaining = ctxWindow - effectiveUsed;
    const tokenThreshold = this.config.tokenThreshold ?? Math.floor(ctxWindow * HARD_COMPACTION_RATIO);

    if (effectiveUsed >= tokenThreshold) return true;
    if (remaining < COMPACTION_RESERVE_TOKENS) return true;

    // 向后兼容：未配置 token 阈值时也检查旧的消息数阈值逻辑。
    if (this.config.tokenThreshold) return false;
    return messages.length > this.config.threshold;
  }

  /** 双轨有效占用（供日志 / 主动收缩判定） */
  getEffectiveUsed(messages: UnifiedMessage[], options?: CompactionUsageOptions): number {
    return this.resolveEffectiveUsed(messages, options);
  }

  /** 层间早退：forceFullCompact 时继续走完硬压缩流水线 */
  private shouldContinueCompactLayers(
    messages: UnifiedMessage[],
    runOptions?: CompactRunOptions,
  ): boolean {
    if (runOptions?.forceFullCompact) return true;
    return this.needsCompaction(messages, runOptions?.usageOptions);
  }

  /**
   * 分离丢弃/保留消息；API 触线但本地 split 无丢弃时，forceFullCompact 强制保留尾部摘要。
   */
  private resolveSplitForCompact(
    compacted: UnifiedMessage[],
    runOptions?: CompactRunOptions,
  ): {
    systemMessages: UnifiedMessage[];
    droppedMessages: UnifiedMessage[];
    recentMessages: UnifiedMessage[];
  } {
    const split = this.splitMessages(compacted);
    if (split.droppedMessages.length > 0 || !runOptions?.forceFullCompact) {
      return split;
    }

    const systemMessages: UnifiedMessage[] = [];
    let contentStart = 0;
    if (compacted.length > 0 && compacted[0].role === 'system') {
      systemMessages.push(compacted[0]);
      contentStart = 1;
    }

    const minRecent = Math.max(this.config.keepRecentMinMessages, 2);
    if (compacted.length <= contentStart + minRecent) {
      return split;
    }

    const splitAt = compacted.length - minRecent;
    return {
      systemMessages,
      droppedMessages: compacted.slice(contentStart, splitAt),
      recentMessages: compacted.slice(splitAt),
    };
  }

  /**
   * 获取当前消息的估算 token 数（供外部查询）。
   */
  getEstimatedTokens(messages: UnifiedMessage[]): number {
    return estimateTokens(messages);
  }

  /**
   * 获取当前配置（供外部查询）。
   */
  getConfig(): CompactionConfig {
    return this.config;
  }

  /**
   * Checkpoint 续跑专用：纯本地 Fork，不调 LLM，不 reinject 文件。
   */
  compactForCheckpointResume(
    messages: UnifiedMessage[],
    resumeSummary: UnifiedMessage,
    options: {
      maxRecentMessages?: number;
      targetTokenRatio?: number;
      aggressive?: boolean;
    } = {},
  ): UnifiedMessage[] {
    const maxRecent = options.maxRecentMessages ?? (options.aggressive ? 40 : 90);
    const targetRatio = options.targetTokenRatio ?? (options.aggressive ? 0.45 : 0.55);
    const targetTokens = Math.floor(readCompactionContextWindowTokens() * targetRatio);

    let working = stripResumeCheckpointMessages(messages);
    working = this.snip(working);
    working = this.microcompact(working);
    working = this.trimToolResults(working);

    const systemMessages: UnifiedMessage[] = [];
    let contentStart = 0;
    if (working.length > 0 && working[0].role === 'system') {
      systemMessages.push(working[0]);
      contentStart = 1;
    }

    const anchorIdx = findCheckpointAnchorIndex(working);
    const anchorMessages = anchorIdx >= contentStart ? [working[anchorIdx]] : [];

    let recent = working.slice(Math.max(contentStart, working.length - maxRecent));
    recent = trimLeadingOrphanToolMessages(recent);
    if (anchorIdx >= contentStart) {
      recent = recent.filter(m => m !== working[anchorIdx]);
    }

    const assemble = (): UnifiedMessage[] => [
      ...systemMessages,
      ...anchorMessages,
      resumeSummary,
      ...recent,
    ];

    let result = assemble();
    let shrinkPass = 0;
    while (estimateTokens(result) > targetTokens && recent.length > 8 && shrinkPass < 12) {
      const drop = Math.max(4, Math.ceil(recent.length * 0.12));
      recent = trimLeadingOrphanToolMessages(recent.slice(drop));
      result = assemble();
      shrinkPass++;
    }

    if (options.aggressive) {
      result = this.trimToolResults(this.microcompact(result));
    }

    return finalizeMessagesForApi(result);
  }

  /** 压缩/fork 产出在写回 messages 前统一修复 tool 配对。 */
  private finalizeCompacted(messages: UnifiedMessage[]): UnifiedMessage[] {
    return finalizeMessagesForApi(messages);
  }

  /**
   * 构建压缩恢复用的结构化 Runtime State。
   *
   * 这条消息在硬压缩后重新注入，优先级高于自然语言摘要，
   * 用于保证模型还能知道当前目标、改动文件和下一步验证命令。
   */
  buildRuntimeRecoveryContext(
    taskState: TaskStateSnapshot,
    repoContext: RepoContextSnapshot,
  ): UnifiedMessage {
    return {
      role: 'user',
      content: [
        '<runtime-recovery-context>',
        'This structured runtime state survived context compaction. Treat it as authoritative for the current task unless the latest user message says otherwise.',
        '',
        '# Runtime State',
        JSON.stringify(taskState, null, 2),
        '',
        '# Repo Context',
        JSON.stringify(repoContext, null, 2),
        '</runtime-recovery-context>',
      ].join('\n'),
    };
  }

  /**
   * 会话记忆压缩路径（参考 claude-code sessionMemoryCompact）。
   *
   * 会话记忆已在后台持续更新，直接作为压缩摘要，不需要额外 LLM 调用。
   * 保留最近消息（token 预算），会话记忆作为摘要注入。
   */
  compactWithSessionMemory(
    messages: UnifiedMessage[],
    sessionNotes: string,
    runOptions?: CompactRunOptions,
  ): UnifiedMessage[] {
    const preCompactMessages = messages.slice();
    const beforeTokens = estimateTokens(messages);
    const beforeMessages = messages.length;

    // 第一层：snip
    let compacted = this.snip(messages);

    // 第二层：microcompact（保留文件操作结果）
    compacted = this.microcompact(compacted);

    // 第三层：裁剪工具结果
    compacted = this.trimToolResults(compacted);

    // 分离消息（使用 token 预算）
    const { systemMessages, droppedMessages, recentMessages } =
      this.resolveSplitForCompact(compacted, runOptions);

    if (droppedMessages.length === 0) return this.finalizeCompacted(compacted);

    const { text: notesBody } = truncateSessionNotesForCompact(sessionNotes, undefined, this.config.sessionId);

    // 用会话记忆作为摘要（替代 LLM 调用）；过长会话笔记截断以免占满预算（D）
    const summaryContent = [
      '<context-summary>',
      'This session is being continued from a previous conversation. Session notes below are the authoritative source for current session state.',
      '',
      '## Precedence rules',
      '1. Current conversation > Session notes > Long-term memory',
      '2. If session notes contradict long-term memory, trust session notes',
      '3. If you detect a contradiction that matters, mention it to the user',
      '',
      notesBody,
      '</context-summary>',
    ].join('\n');

    const summaryMsg = { role: 'user' as const, content: summaryContent };
    const core = [...systemMessages, summaryMsg, ...recentMessages];
    const meta: CompactBoundaryMeta = {
      beforeTokens,
      beforeMessages,
      afterTokens: estimateTokens(core),
      afterMessages: core.length,
    };

    const anchors: UnifiedMessage[] = [
      { role: 'user', content: buildCompactBoundaryContent(meta) },
      { role: 'user', content: buildRecentDialogueFocusContent(preCompactMessages) },
    ];

    return this.finalizeCompacted([...systemMessages, summaryMsg, ...anchors, ...recentMessages]);
  }

  /**
   * 从消息历史中提取最近读取的文件内容。
   *
   * 压缩后重新注入，确保 LLM 不丢失已读的源码。
   * 参考 claude-code 的 createPostCompactFileAttachments。
   *
   * 唯一路径条数上限取自 {@link CompactionConfig.maxReinjectFiles}；
   * 传入 maxFiles 时在单次调用上覆盖该配置。
   */
  extractRecentFileContents(
    messages: UnifiedMessage[],
    maxFiles?: number,
    maxTotalTokens?: number,
  ): UnifiedMessage[] {
    const tokenLimit = maxTotalTokens ?? this.config.maxReinjectTokens;
    const maxCap = this.config.maxReinjectFiles;

    // 构建 toolCallId → toolName 映射
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolCallIdToName.set(tc.id, tc.name);
        }
      }
    }

    // 统计最近 10 轮内 read_file 的 assistant 消息索引
    let assistantTurn = 0;
    const assistantTurnMap = new Map<number, number>();
    const readFileTurns: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        assistantTurn++;
        if (msg.toolCalls.some(tc => tc.name === 'read_file')) {
          readFileTurns.push(assistantTurn);
        }
      }
      assistantTurnMap.set(i, assistantTurn);
    }
    const currentTurn = assistantTurn;

    // 动态文件上限：最近 10 轮内 read_file 轮次数（无则沿用 ≤8 的启发上限），且不超过 maxReinjectFiles
    const recentReadFileTurns = readFileTurns.filter(t => currentTurn - t < 10);
    const fallbackHint = Math.min(8, maxCap);
    const dynamicFileLimit =
      maxFiles ?? Math.min(recentReadFileTurns.length || fallbackHint, maxCap);

    // 从后往前找最近的 read_file 结果
    const fileResults: { path: string; content: string }[] = [];
    const seenPaths = new Set<string>();

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'tool' || !msg.toolCallId) continue;
      if (toolCallIdToName.get(msg.toolCallId) !== 'read_file') continue;
      if (typeof msg.content !== 'string' || !msg.content.trim()) continue;

      const filePath = this.findToolArg(messages, msg.toolCallId, 'path');
      if (!filePath || seenPaths.has(filePath)) continue;

      seenPaths.add(filePath);
      fileResults.unshift({ path: filePath, content: msg.content });

      if (fileResults.length >= dynamicFileLimit) break;
    }

    // 搜索结果保护：收集最近 3 轮内 search_codebase 的结果
    const searchResults: string[] = [];
    for (let i = messages.length - 1; i >= 0 && searchResults.length < 3; i--) {
      const msg = messages[i];
      if (msg.role !== 'tool' || !msg.toolCallId) continue;
      if (toolCallIdToName.get(msg.toolCallId) !== 'search_codebase') continue;
      if (typeof msg.content !== 'string' || !msg.content.trim()) continue;
      searchResults.unshift(msg.content.substring(0, 300));
    }

    if (fileResults.length === 0 && searchResults.length === 0) return [];

    // 格式化为 user 消息，受 token 预算限制
    const parts: string[] = ['<recent-file-contents>'];
    let totalChars = 0;
    const charLimit = tokenLimit * 4;

    for (const { path, content } of fileResults) {
      const entry = `\n### ${path}\n\`\`\`\n${content}\n\`\`\``;
      if (totalChars + entry.length > charLimit) break;
      parts.push(entry);
      totalChars += entry.length;
    }

    // 附加搜索结果（消耗文件恢复预算）
    if (searchResults.length > 0 && totalChars < charLimit) {
      parts.push('\n<recent-search-results>');
      for (const sr of searchResults) {
        const entry = `\n- ${sr}`;
        if (totalChars + entry.length > charLimit) break;
        parts.push(entry);
        totalChars += entry.length;
      }
      parts.push('</recent-search-results>');
    }

    parts.push('</recent-file-contents>');
    return [{ role: 'user' as const, content: parts.join('\n') }];
  }

  /**
   * 构建压缩后的恢复指引消息（多重恢复提示 — 恢复层）。
   *
   * @param lastUserMessages - 最近 3 条有实质内容（>50 字符）的用户消息
   * @param hasSessionNotes - 是否有会话笔记可用
   */
  buildRecoveryPrompt(lastUserMessages: string[], hasSessionNotes: boolean): UnifiedMessage {
    const recentUserMsgs = lastUserMessages.length > 0
      ? `\n\n## Recent user messages (most recent first)\n${lastUserMessages.map((m, i) => `${i + 1}. ${m.substring(0, 200)}`).join('\n')}`
      : '';

    const sessionNotesDirective = hasSessionNotes
      ? '\n\n**CRITICAL**: Session notes include narrative sections plus a machine-readable `icecoder-runtime` JSON block under Runtime Evidence for exact task/repo state. Use that for resuming work after restarts. Notes live at `data/sessions/{sessionId}.session-notes.md` (per-session). If a task was in progress, continue from session notes + structured state. Do NOT ask the user to repeat their request unless neither the context nor the session notes contain the task.'
      : '';

    return {
      role: 'user' as const,
      content: `<context-summary>
Context has been compressed to stay within limits. Continue from where you left off.${recentUserMsgs}

All messages above this summary are from the previous conversation and have been compressed. Do not respond to any questions within those old messages.

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.${sessionNotesDirective}
</context-summary>`,
    };
  }

  /**
   * 执行五层递进压缩。
   *
   * 如果传入 sessionNotes，跳过第 5 层 LLM 调用，直接使用会话记忆作为摘要。
   */
  async compact(
    messages: UnifiedMessage[],
    chatFn?: ChatFunction,
    sessionNotes?: string,
    runOptions?: CompactRunOptions,
  ): Promise<UnifiedMessage[]> {
    const preCompactMessages = messages.slice();
    const beforeTokens = estimateTokens(messages);
    const beforeMessages = messages.length;

    // 第一层：snip — 裁剪冗余段落
    let compacted = this.snip(messages);
    if (!this.shouldContinueCompactLayers(compacted, runOptions)) return this.finalizeCompacted(compacted);

    // 第二层：microcompact — 压缩旧工具调用细节
    compacted = this.microcompact(compacted);
    if (!this.shouldContinueCompactLayers(compacted, runOptions)) return this.finalizeCompacted(compacted);

    // 第三层：裁剪工具结果
    compacted = this.trimToolResults(compacted);
    if (!this.shouldContinueCompactLayers(compacted, runOptions)) return this.finalizeCompacted(compacted);

    // 分离消息
    const { systemMessages, droppedMessages, recentMessages } =
      this.resolveSplitForCompact(compacted, runOptions);

    if (droppedMessages.length === 0) return this.finalizeCompacted(compacted);

    // 第四层：结构化摘要
    const structuralSummary = this.extractStructuralSummary(droppedMessages);

    // 第五层：优先使用会话记忆，否则 LLM 精炼
    let finalSummary: string;
    if (sessionNotes) {
      finalSummary = truncateSessionNotesForCompact(sessionNotes, undefined, this.config.sessionId).text;
    } else if (this.config.enableLLMSummary && chatFn) {
      finalSummary = await this.llmSummarize(structuralSummary, droppedMessages, chatFn);
    } else {
      finalSummary = structuralSummary;
    }

    const summaryMsg = {
      role: 'user' as const,
      content: `<context-summary>\n${finalSummary}\n</context-summary>`,
    };
    const core = [...systemMessages, summaryMsg, ...recentMessages];
    const meta: CompactBoundaryMeta = {
      beforeTokens,
      beforeMessages,
      afterTokens: estimateTokens(core),
      afterMessages: core.length,
    };

    const anchors: UnifiedMessage[] = [
      { role: 'user', content: buildCompactBoundaryContent(meta) },
      { role: 'user', content: buildRecentDialogueFocusContent(preCompactMessages) },
    ];

    return this.finalizeCompacted([...systemMessages, summaryMsg, ...anchors, ...recentMessages]);
  }

  /**
   * 从消息历史中提取任务描述（最早的长度 > 200 字符的用户消息）。
   * 用于压缩前备份到会话笔记，确保压缩后模型能找回任务目标。
   * @returns 截取前 300 字符的任务摘要，若无长用户消息则返回 null
   */
  getTaskDescription(messages: UnifiedMessage[]): string | null {
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length > 200) {
        return content.substring(0, 300);
      }
    }
    return null;
  }

  /**
   * 第一层：Snip — 裁剪历史中的冗余段落。
   *
   * - 删除重复的 <system-reminder>（只保留最后一个）
   * - 删除重复的 <system-context>（只保留最后一个）
   * - 删除旧的 <context-summary>（被新的替代）
   * - 删除重复的 <compact_boundary> / <recent-dialogue-focus>（各只保留最后一条）
   * - 删除空内容的 assistant 消息
   */
  private snip(messages: UnifiedMessage[]): UnifiedMessage[] {
    let lastReminderIdx = -1;
    let lastSummaryIdx = -1;
    let lastContextIdx = -1;
    let lastBoundaryIdx = -1;
    let lastFocusIdx = -1;
    let lastResumeIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = typeof messages[i].content === 'string' ? messages[i].content as string : '';
      if (lastReminderIdx === -1 && content.startsWith('<system-reminder>')) lastReminderIdx = i;
      if (lastSummaryIdx === -1 && content.startsWith('<context-summary>')) lastSummaryIdx = i;
      if (lastContextIdx === -1 && content.startsWith('<system-context>')) lastContextIdx = i;
      if (lastBoundaryIdx === -1 && content.startsWith('<compact_boundary')) lastBoundaryIdx = i;
      if (lastFocusIdx === -1 && content.startsWith('<recent-dialogue-focus')) lastFocusIdx = i;
      if (lastResumeIdx === -1 && isResumeCheckpointContent(content)) lastResumeIdx = i;
    }

    return messages.filter((msg, idx) => {
      const content = typeof msg.content === 'string' ? msg.content as string : '';
      if (content.startsWith('<system-reminder>') && idx !== lastReminderIdx) return false;
      if (content.startsWith('<context-summary>') && idx !== lastSummaryIdx) return false;
      if (content.startsWith('<system-context>') && idx !== lastContextIdx) return false;
      if (content.startsWith('<compact_boundary') && idx !== lastBoundaryIdx) return false;
      if (content.startsWith('<recent-dialogue-focus') && idx !== lastFocusIdx) return false;
      if (isResumeCheckpointContent(content) && idx !== lastResumeIdx) return false;
      if (msg.role === 'assistant' && !msg.toolCalls?.length && !content.trim()) return false;
      return true;
    });
  }

  /**
   * 第二层：Microcompact — 压缩旧工具调用的细节。
   *
   * 对非最近 N 轮的工具调用，只保留工具名和结果状态，
   * 删除参数细节和完整输出。
   *
   * 例外：read_file / write_file / edit_file / append_file 的结果不压缩。
   * 源码是编码 agent 的核心上下文，压缩后 LLM 会反复重新读取文件。
   */
  private microcompact(messages: UnifiedMessage[]): UnifiedMessage[] {
    const recentStart = Math.max(0, messages.length - this.config.keepRecent);

    // 构建 toolCallId → toolName 映射，用于判断 tool 结果对应的工具类型
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolCallIdToName.set(tc.id, tc.name);
        }
      }
    }

    // 文件操作工具 — 结果保留完整内容（源码是编码 agent 的核心上下文）
    const FILE_TOOLS = FILE_TOOLS_PRESERVE_FULL_OUTPUT;

    return messages.map((msg, idx) => {
      if (idx >= recentStart) return msg;

      // 压缩旧的 assistant tool_calls（保留工具名，清除参数）
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const cleaned = prepareAssistantContentForHistory(
          typeof msg.content === 'string' ? msg.content : '',
        );
        return {
          ...msg,
          content: cleaned,
          toolCalls: msg.toolCalls.map(tc => ({ ...tc, arguments: {} })),
        };
      }

      // 压缩旧的 tool 结果（文件操作工具的结果不压缩）
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        const toolName = msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined;
        if (toolName && FILE_TOOLS.has(toolName)) return msg; // 保留完整内容

        const content = msg.content;
        const isError = content.startsWith('工具执行错误') || content.startsWith('工具调用被拒绝');
        const status = isError ? '失败' : '成功';
        const preview = content.substring(0, 50).replace(/\n/g, ' ');
        return { ...msg, content: `[${status}] ${preview}${content.length > 50 ? '...' : ''}` };
      }

      return msg;
    });
  }

  /**
   * 裁剪超长的工具结果。
   *
   * 文件操作工具的结果上限更高（maxToolResultLength * 5），
   * 因为源码是编码 agent 的核心上下文。
   */
  trimToolResults(messages: UnifiedMessage[]): UnifiedMessage[] {
    // 构建 toolCallId → toolName 映射
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolCallIdToName.set(tc.id, tc.name);
        }
      }
    }

    const FILE_TOOLS = FILE_TOOLS_PRESERVE_FULL_OUTPUT;

    return messages.map(msg => {
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        const toolName = msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined;
        const isFileOp = toolName && FILE_TOOLS.has(toolName);
        const limit = isFileOp
          ? this.config.maxToolResultLength * 5  // 文件操作：15000 字符
          : this.config.maxToolResultLength;      // 其他工具：3000 字符

        if (msg.content.length > limit) {
          return {
            ...msg,
            content: msg.content.substring(0, limit) +
              `\n...[truncated, original length: ${msg.content.length} chars]`,
          };
        }
      }
      return msg;
    });
  }

  /**
   * 将消息分为三部分：system、要删除的、要保留的。
   *
   * 保证消息对完整性：如果切割点落在 assistant(tool_calls) 和 tool 结果之间，
   * 向前调整切割点，把整个工具交互对保留在一起。
   *
   * 文件操作工具的结果（read_file 等）始终保留在 recent 中，
   * 因为源码是编码 agent 的核心上下文。
   */
  private splitMessages(messages: UnifiedMessage[]): {
    systemMessages: UnifiedMessage[];
    droppedMessages: UnifiedMessage[];
    recentMessages: UnifiedMessage[];
  } {
    // 构建文件操作的 toolCallId 集合
    const fileToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (['read_file', 'write_file', 'edit_file', 'append_file', 'patch_file'].includes(tc.name)) {
            fileToolCallIds.add(tc.id);
          }
        }
      }
    }

    const systemMessages: UnifiedMessage[] = [];
    let contentStart = 0;

    // 提取 system 消息
    if (messages.length > 0 && messages[0].role === 'system') {
      systemMessages.push(messages[0]);
      contentStart = 1;
    }

    // 计算初始切割点（token 预算优先，参考 claude-code: ≥10K token, ≥5 条消息, ≤40K token）
    let splitAt = this.findSplitByTokenBudget(messages, contentStart);

    // 保护长篇分析文本（assistant 无 toolCalls 且 content > 500 字符），
    // 这类消息通常是分析报告，压缩后会丢失关键上下文导致重复分析。
    for (let i = contentStart; i < splitAt; i++) {
      const msg = messages[i];
      if (
        msg.role === 'assistant'
        && !msg.toolCalls?.length
        && typeof msg.content === 'string'
        && msg.content.length > 500
      ) {
        splitAt = i;
        break;
      }
    }

    // 保护包含任务描述的长用户消息（content > MIN_USER_MSG_LENGTH_TO_PRESERVE），
    // 这类消息通常是用户最初的任务说明，压缩后丢失会导致模型无法继续执行任务。
    for (let i = contentStart; i < splitAt; i++) {
      const msg = messages[i];
      if (
        msg.role === 'user'
        && typeof msg.content === 'string'
        && msg.content.length > MIN_USER_MSG_LENGTH_TO_PRESERVE
      ) {
        splitAt = i;
        break;
      }
    }

    // 保护有实质内容的最近用户指令：从后往前找最近 3 条 user 消息，
    // 将其中 content.length > 50 的消息纳入保留集
    const forcePreserve = new Set<number>();
    let recentUserCount = 0;
    for (let i = messages.length - 1; i >= contentStart && recentUserCount < 3; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      if (typeof msg.content !== 'string') continue;
      recentUserCount++;
      if (msg.content.length > SHORT_USER_MSG_MAX_LENGTH) {
        forcePreserve.add(i);
      }
    }
    for (let i = contentStart; i < messages.length; i++) {
      if (shouldPreserveMessageOnCompaction(messages[i])) {
        forcePreserve.add(i);
      }
    }

    // 将 forcePreserve 中最小的索引作为新的切割点
    if (forcePreserve.size > 0) {
      const minPreserve = Math.min(...forcePreserve);
      if (minPreserve < splitAt) {
        splitAt = minPreserve;
      }
    }

    // C：后缀中至少保留若干条「真实 user」轮次，避免只剩工具噪声
    splitAt = this.ensureMinimumRealUsersInSuffix(
      messages,
      contentStart,
      splitAt,
      MIN_REAL_USERS_IN_SUFFIX,
    );

    // 消息对完整性修正：
    // 如果 splitAt 处是 tool 消息，说明它的 assistant(tool_calls) 在前面，
    // 需要向前找到对应的 assistant 消息，把整个交互对放到 recent 中。
    while (splitAt > contentStart && messages[splitAt]?.role === 'tool') {
      splitAt--;
    }

    // 如果 splitAt 处是 assistant 且有 toolCalls，它的 tool 结果在后面，
    // 也需要一起保留，所以不动 splitAt（tool 结果已经在 recent 中了）。
    // 但如果 splitAt-1 是 assistant 且有 toolCalls，说明我们刚好切在
    // assistant 和 tool 之间，需要把 assistant 也放到 recent 中。
    if (
      splitAt > contentStart
      && messages[splitAt - 1]?.role === 'assistant'
      && messages[splitAt - 1]?.toolCalls?.length
    ) {
      // 检查 splitAt 处是否是对应的 tool 结果
      if (messages[splitAt]?.role === 'tool') {
        splitAt--;
      }
    }

    // 向前扩展切割点，确保文件操作的 assistant + tool 交互对不被拆分
    while (splitAt > contentStart) {
      const msg = messages[splitAt];
      if (msg.role === 'tool' && msg.toolCallId && fileToolCallIds.has(msg.toolCallId)) {
        splitAt--;
        continue;
      }
      if (
        msg.role === 'assistant' && msg.toolCalls &&
        msg.toolCalls.some(tc => fileToolCallIds.has(tc.id))
      ) {
        splitAt--;
        continue;
      }
      break;
    }

    return {
      systemMessages,
      droppedMessages: messages.slice(contentStart, splitAt),
      recentMessages: messages.slice(splitAt),
    };
  }

  /**
   * 第四层：结构化摘要提取。
   *
   * 文件操作工具的结果给予更多摘要空间（保留 500 字符而非 80）。
   */
  private extractStructuralSummary(messages: UnifiedMessage[]): string {
    // 构建 toolCallId → toolName 映射
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolCallIdToName.set(tc.id, tc.name);
        }
      }
    }

    const FILE_TOOLS = FILE_TOOLS_PRESERVE_FULL_OUTPUT;

    const lines: string[] = [];
    lines.push(`以下是之前 ${messages.length} 条对话的结构化摘要：`);

    for (const msg of messages) {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '[多模态内容]';
        if (
          content.startsWith('<system-reminder>')
          || content.startsWith('<context-summary>')
          || isSyntheticUserBlockContent(content)
        ) {
          continue;
        }
        const truncated = content.length > 100 ? content.substring(0, 100) + '...' : content;
        lines.push(`- 用户: ${truncated}`);
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolNames = msg.toolCalls.map(tc => {
            const argsStr = JSON.stringify(tc.arguments);
            const truncatedArgs = argsStr.length > 80 ? argsStr.substring(0, 80) + '...' : argsStr;
            return `${tc.name}(${truncatedArgs})`;
          });
          lines.push(`- 助手调用工具: ${toolNames.join(', ')}`);
        } else {
          const content = typeof msg.content === 'string' ? msg.content : '';
          if (content) {
            const truncated = content.length > 100 ? content.substring(0, 100) + '...' : content;
            lines.push(`- 助手: ${truncated}`);
          }
        }
      } else if (msg.role === 'tool') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const isError = content.startsWith('工具执行错误') || content.startsWith('工具调用被拒绝') || content.startsWith('[失败]');
        const status = isError ? '❌' : '✅';

        // 文件操作工具的结果保留更多内容（500 字符而非 80）
        const toolName = msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined;
        const maxLen = (toolName && FILE_TOOLS.has(toolName)) ? 500 : 80;
        const truncated = content.length > maxLen ? content.substring(0, maxLen) + '...' : content;
        lines.push(`  ${status} 结果: ${truncated}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 第五层：LLM 精炼摘要。
   */
  private async llmSummarize(
    structuralSummary: string,
    _droppedMessages: UnifiedMessage[],
    chatFn: ChatFunction,
  ): Promise<string> {
    try {
      const summarizeMessages: UnifiedMessage[] = [
        {
          role: 'system',
          content: 'You are a context compaction assistant. Refine the following conversation summary into a more concise version. Preserve: 1) user core intent 2) key tool calls and their results — especially file contents (read_file results contain source code that the agent needs) 3) important decisions and findings. Remove duplicates and unimportant details. Keep under 500 words.',
        },
        {
          role: 'user',
          content: structuralSummary,
        },
      ];

      const response = await chatFn(summarizeMessages, { tools: [] });
      if (response.content && response.content.length > 0) {
        return response.content;
      }
    } catch {
      // LLM 摘要失败，回退到结构化摘要
    }

    return structuralSummary;
  }

  /**
   * 根据 token 预算计算切割点。
   *
   * 从消息末尾向前扫描，累计 token 直到满足以下条件之一：
   * 1. 累计 token ≥ keepRecentMinTokens 且消息数 ≥ keepRecentMinMessages
   * 2. 累计 token ≥ keepRecentMaxTokens（硬上限）
   * 3. 到达消息列表开头
   *
   * 同时受 keepRecent（消息数上限）约束。
   */
  private findSplitByTokenBudget(messages: UnifiedMessage[], contentStart: number): number {
    let tokenCount = 0;
    let messageCount = 0;
    const minTokens = this.config.keepRecentMinTokens;
    const maxTokens = this.config.keepRecentMaxTokens;
    const minMessages = this.config.keepRecentMinMessages;
    const maxMessages = this.config.keepRecent;

    // 从末尾向前扫描
    for (let i = messages.length - 1; i >= contentStart; i--) {
      const msgTokens = estimateTokens([messages[i]]);
      tokenCount += msgTokens;
      messageCount++;

      // 硬上限：token 超过最大值
      if (tokenCount >= maxTokens) {
        return i;
      }

      // 消息数上限
      if (messageCount >= maxMessages) {
        return i;
      }

      // 满足最小要求后可以停止
      if (tokenCount >= minTokens && messageCount >= minMessages) {
        return i;
      }
    }

    return contentStart;
  }

  /** 从索引 fromIdx 起后缀中的非注入 user 条数 */
  private countNonSyntheticUsersFrom(messages: UnifiedMessage[], fromIdx: number): number {
    let n = 0;
    for (let i = fromIdx; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      if (isSyntheticUserBlockContent(m.content)) continue;
      if (m.content.trim().length > 0) n++;
    }
    return n;
  }

  private ensureMinimumRealUsersInSuffix(
    messages: UnifiedMessage[],
    contentStart: number,
    splitAt: number,
    minUsers: number,
  ): number {
    let s = splitAt;
    while (s > contentStart && this.countNonSyntheticUsersFrom(messages, s) < minUsers) {
      s--;
    }
    return s;
  }

  /**
   * 从消息历史中查找指定 toolCallId 的工具调用参数。
   */
  private findToolArg(messages: UnifiedMessage[], toolCallId: string, argName: string): string | undefined {
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (tc.id === toolCallId) {
          return tc.arguments?.[argName] != null ? String(tc.arguments[argName]) : undefined;
        }
      }
    }
    return undefined;
  }
}
