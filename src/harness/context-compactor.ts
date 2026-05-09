/**
 * 上下文压缩器 — 参考 claude-code 的分层策略。
 *
 * 压缩触发阈值为动态计算：contextWindow × compactionRatio。
 * - contextWindow：ICE_CONTEXT_WINDOW 环境变量 > 默认 provider maxContextTokens > 最大 provider maxContextTokens > 默认 128K
 * - compactionRatio：通过 ICE_COMPACTION_RATIO 环境变量配置（默认 0.88，即 88%）
 * - 1M 窗口 → 阈值 880K，128K 窗口 → 阈值 112K
 *
 * 两条压缩路径：
 * - 会话记忆路径（compactWithSessionMemory）：0 LLM 成本，会话记忆作为摘要
 * - LLM 路径（compact）：五层递进，可选 LLM 精炼
 *
 * 五层压缩：
 * 1. snip — 裁剪冗余段落（重复的 system-reminder、context-summary）
 * 2. microcompact — 压缩旧工具调用细节（文件操作结果保留完整）
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

import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedMessage } from '../llm/types.js';
import { estimateMessagesTokens } from '../llm/token-estimator.js';
import type { ChatFunction } from './types.js';
import type { TaskStateSnapshot } from './task-state.js';
import type { RepoContextSnapshot } from './repo-context.js';

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
  /** 重新注入最近文件内容的最大文件数 */
  maxReinjectFiles: number;
  /** 重新注入最近文件内容的总 token 预算 */
  maxReinjectTokens: number;
}

/** 默认上下文窗口大小（未配置时的兜底值） */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 用户消息内容长度超过此阈值时强制保留，防止任务描述被压缩丢弃 */
const MIN_USER_MSG_LENGTH_TO_PRESERVE = 200;

/** 简短用户消息阈值：长度低于此值的确认消息在轻量压缩中可丢弃 */
const SHORT_USER_MSG_MAX_LENGTH = 50;

/** 轻量微压缩触发比例（可通过 ICE_MICRO_COMPACT_RATIO 环境变量覆盖） */
const MICRO_COMPACT_RATIO = (() => {
  const env = parseFloat(process.env.ICE_MICRO_COMPACT_RATIO || '');
  return Number.isFinite(env) && env > 0 && env <= 1 ? env : 0.65;
})();

/** 每会话最大微压缩次数 */
const MAX_MICRO_COMPACTS_PER_SESSION = 3;

/** 硬压缩触发比例（可通过 ICE_COMPACTION_RATIO 环境变量覆盖） */
const DEFAULT_COMPACTION_RATIO = 0.88;

/** 硬压缩准备金 token 数（可通过 ICE_COMPACTION_RESERVE_TOKENS 环境变量覆盖） */
const COMPACTION_RESERVE_TOKENS = (() => {
  const env = parseInt(process.env.ICE_COMPACTION_RESERVE_TOKENS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : 15000;
})();

/**
 * 读取上下文窗口大小。优先级：
 * 1. ICE_CONTEXT_WINDOW 环境变量（手动覆盖）
 * 2. data/config.json 中当前 provider 的 maxContextTokens（自动获取）
 * 3. 默认 128K
 */
function getContextWindow(): number {
  // 1. 环境变量优先
  const env = parseInt(process.env.ICE_CONTEXT_WINDOW || '', 10);
  if (Number.isFinite(env) && env > 0) return env;

  // 2. 从 provider 配置读取当前默认 provider 的 maxContextTokens；未标记默认时回退最大值。
  try {
    const configPath = path.resolve('data/config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { providers?: Array<{ maxContextTokens?: number; isDefault?: boolean }> };
    const defaultProvider = config.providers?.find(p => p.isDefault && p.maxContextTokens);
    if (defaultProvider?.maxContextTokens && defaultProvider.maxContextTokens > 0) {
      return defaultProvider.maxContextTokens;
    }
    let maxCtx = 0;
    for (const p of config.providers ?? []) {
      if (p.maxContextTokens && p.maxContextTokens > maxCtx) {
        maxCtx = p.maxContextTokens;
      }
    }
    if (maxCtx > 0) return maxCtx;
  } catch { /* 配置文件不存在或解析失败，使用默认值 */ }

  // 3. 兜底
  return DEFAULT_CONTEXT_WINDOW;
}

/** 从环境变量读取压缩触发比例（0-1 之间） */
function getCompactionRatio(): number {
  const env = parseFloat(process.env.ICE_COMPACTION_RATIO || '');
  return Number.isFinite(env) && env > 0 && env <= 1 ? env : DEFAULT_COMPACTION_RATIO;
}

const DEFAULT_CONFIG: CompactionConfig = {
  threshold: 40,
  tokenThreshold: Math.floor(getContextWindow() * getCompactionRatio()),
  keepRecent: 40,
  keepRecentMinTokens: 10000,
  keepRecentMaxTokens: 40000,
  keepRecentMinMessages: 5,
  maxToolResultLength: 3000,
  enableLLMSummary: true,
  maxReinjectFiles: 8,
  maxReinjectTokens: 50000,
};

/**
 * 估算消息列表的 token 数。
 * 委托给统一的 token-estimator，保持向后兼容的导出。
 */
export function estimateTokens(messages: UnifiedMessage[]): number {
  return estimateMessagesTokens(messages);
}

function isShortActionInstruction(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return /^(跑|运行|执行|测|测试|修|修改|改|继续|提交|检查|验证)/.test(trimmed)
    || /\b(run|test|fix|edit|continue|commit|check|verify)\b/i.test(trimmed);
}

/**
 * ContextCompactor 管理对话历史的压缩，防止 token 溢出。
 */
export class ContextCompactor {
  private config: CompactionConfig;
  /** 微压缩计数器（每会话最多 MAX_MICRO_COMPACTS_PER_SESSION 次） */
  private microCompactCount = 0;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查是否需要轻量微压缩（在硬压缩之前）。
   * 微压缩在 65% 上下文使用量时触发，纯本地操作，零 LLM 成本。
   */
  needsMicroCompaction(messages: UnifiedMessage[]): boolean {
    if (this.microCompactCount >= MAX_MICRO_COMPACTS_PER_SESSION) return false;
    const ctxWindow = getContextWindow();
    const currentTokens = estimateTokens(messages);
    const microThreshold = Math.floor(ctxWindow * MICRO_COMPACT_RATIO);
    return currentTokens > microThreshold;
  }

  /**
   * 执行轻量微压缩（预防层）。
   *
   * 纯本地操作，不调用 LLM：
   * - 截断超过 5 轮的工具结果为最多 500 字符
   * - 丢弃长度 < 50 字符的简短确认消息
   * 微压缩后不注入恢复提示，对 LLM 完全透明。
   */
  doLightCompact(messages: UnifiedMessage[]): UnifiedMessage[] {
    this.microCompactCount++;

    // 统计 assistant 消息轮次（每个 assistant 消息算一轮）
    let assistantTurnCount = 0;
    const msgTurnMap = new Map<number, number>();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'assistant' && messages[i].toolCalls?.length) {
        assistantTurnCount++;
      }
      msgTurnMap.set(i, assistantTurnCount);
    }
    const currentTurn = assistantTurnCount;

    return messages.filter((msg, idx) => {
      // 丢弃简短确认消息，但保留短执行指令（如“跑测试”“继续”“fix it”）。
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.length < SHORT_USER_MSG_MAX_LENGTH) {
        if (isShortActionInstruction(msg.content)) return true;
        return false;
      }

      // 截断旧工具结果（超过 5 轮的非文件操作工具结果）
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        const msgTurn = msgTurnMap.get(idx) ?? 0;
        if (currentTurn - msgTurn > 5 && msg.content.length > 500) {
          // 保留工具名和状态，截断内容
          return true; // 保留消息但会在后续被 trimToolResults 裁剪
        }
      }

      return true;
    });
  }

  /**
   * 检查是否需要硬压缩（双重校验）。
   *
   * 条件：
   * 1. 剩余空间不足 COMPACTION_RESERVE_TOKENS token，且
   * 2. 当前使用量 >= contextWindow × DEFAULT_COMPACTION_RATIO
   */
  needsCompaction(messages: UnifiedMessage[]): boolean {
    const ctxWindow = getContextWindow();
    const currentTokens = estimateTokens(messages);
    const remaining = ctxWindow - currentTokens;
    const ratioThreshold = Math.floor(ctxWindow * DEFAULT_COMPACTION_RATIO);

    if (remaining >= COMPACTION_RESERVE_TOKENS) return false;
    if (currentTokens < ratioThreshold) return false;

    // 向后兼容：也检查旧的阈值逻辑
    if (this.config.tokenThreshold) {
      return currentTokens > this.config.tokenThreshold;
    }
    return messages.length > this.config.threshold;
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
   * 构建压缩恢复用的结构化 Runtime State。
   *
   * 这条消息在硬压缩后重新注入，优先级高于自然语言摘要，
   * 用于保证 Agent 还能知道当前目标、改动文件和下一步验证命令。
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
  ): UnifiedMessage[] {
    // 第一层：snip
    let compacted = this.snip(messages);

    // 第二层：microcompact（保留文件操作结果）
    compacted = this.microcompact(compacted);

    // 第三层：裁剪工具结果
    compacted = this.trimToolResults(compacted);

    // 分离消息（使用 token 预算）
    const { systemMessages, droppedMessages, recentMessages } =
      this.splitMessages(compacted);

    if (droppedMessages.length === 0) return compacted;

    // 用会话记忆作为摘要（替代 LLM 调用）
    const summaryContent = [
      '<context-summary>',
      'This session is being continued from a previous conversation. Session notes below are the authoritative source for current session state.',
      '',
      '## Precedence rules',
      '1. Current conversation > Session notes > Long-term memory',
      '2. If session notes contradict long-term memory, trust session notes',
      '3. If you detect a contradiction that matters, mention it to the user',
      '',
      sessionNotes,
      '</context-summary>',
    ].join('\n');

    return [
      ...systemMessages,
      { role: 'user' as const, content: summaryContent },
      ...recentMessages,
    ];
  }

  /**
   * 从消息历史中提取最近读取的文件内容。
   *
   * 压缩后重新注入，确保 LLM 不丢失已读的源码。
   * 参考 claude-code 的 createPostCompactFileAttachments。
   */
  extractRecentFileContents(
    messages: UnifiedMessage[],
    maxFiles?: number,
    maxTotalTokens?: number,
  ): UnifiedMessage[] {
    const tokenLimit = maxTotalTokens ?? this.config.maxReinjectTokens;

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

    // 动态文件上限：最近 10 轮内 read_file 的唯一文件数，上限 12
    const recentReadFileTurns = readFileTurns.filter(t => currentTurn - t < 10);
    const dynamicFileLimit = maxFiles ?? Math.min(recentReadFileTurns.length || 8, 12);

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
      ? '\n\n**CRITICAL**: Check the session notes (data/sessions/session-notes.md) for the current task specification. If a task was in progress, continue executing it using the session notes as the authoritative source. Do NOT ask the user to repeat their request unless neither the context nor the session notes contain the task.'
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
  ): Promise<UnifiedMessage[]> {
    // 第一层：snip — 裁剪冗余段落
    let compacted = this.snip(messages);
    if (!this.needsCompaction(compacted)) return compacted;

    // 第二层：microcompact — 压缩旧工具调用细节
    compacted = this.microcompact(compacted);
    if (!this.needsCompaction(compacted)) return compacted;

    // 第三层：裁剪工具结果
    compacted = this.trimToolResults(compacted);
    if (!this.needsCompaction(compacted)) return compacted;

    // 分离消息
    const { systemMessages, droppedMessages, recentMessages } =
      this.splitMessages(compacted);

    if (droppedMessages.length === 0) return compacted;

    // 第四层：结构化摘要
    const structuralSummary = this.extractStructuralSummary(droppedMessages);

    // 第五层：优先使用会话记忆，否则 LLM 精炼
    let finalSummary: string;
    if (sessionNotes) {
      finalSummary = sessionNotes;
    } else if (this.config.enableLLMSummary && chatFn) {
      finalSummary = await this.llmSummarize(structuralSummary, droppedMessages, chatFn);
    } else {
      finalSummary = structuralSummary;
    }

    return [
      ...systemMessages,
      { role: 'user' as const, content: `<context-summary>\n${finalSummary}\n</context-summary>` },
      ...recentMessages,
    ];
  }

  /**
   * 从消息历史中提取任务描述（最早的长度 > 200 字符的用户消息）。
   * 用于压缩前备份到会话笔记，确保压缩后 Agent 能找回任务目标。
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
   * - 删除空内容的 assistant 消息
   */
  private snip(messages: UnifiedMessage[]): UnifiedMessage[] {
    let lastReminderIdx = -1;
    let lastSummaryIdx = -1;
    let lastContextIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = typeof messages[i].content === 'string' ? messages[i].content as string : '';
      if (lastReminderIdx === -1 && content.startsWith('<system-reminder>')) lastReminderIdx = i;
      if (lastSummaryIdx === -1 && content.startsWith('<context-summary>')) lastSummaryIdx = i;
      if (lastContextIdx === -1 && content.startsWith('<system-context>')) lastContextIdx = i;
    }

    return messages.filter((msg, idx) => {
      const content = typeof msg.content === 'string' ? msg.content as string : '';
      if (content.startsWith('<system-reminder>') && idx !== lastReminderIdx) return false;
      if (content.startsWith('<context-summary>') && idx !== lastSummaryIdx) return false;
      if (content.startsWith('<system-context>') && idx !== lastContextIdx) return false;
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
    const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'append_file', 'patch_file']);

    return messages.map((msg, idx) => {
      if (idx >= recentStart) return msg;

      // 压缩旧的 assistant tool_calls（保留工具名，清除参数）
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const toolNames = msg.toolCalls.map(tc => tc.name).join(', ');
        return {
          ...msg,
          content: `[调用工具: ${toolNames}]`,
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

    const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'append_file', 'patch_file']);

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
    // 这类消息通常是用户最初的任务说明，压缩后丢失会导致 Agent 无法继续执行任务。
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
    // 将 forcePreserve 中最小的索引作为新的切割点
    if (forcePreserve.size > 0) {
      const minPreserve = Math.min(...forcePreserve);
      if (minPreserve < splitAt) {
        splitAt = minPreserve;
      }
    }

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

    const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'append_file', 'patch_file']);

    const lines: string[] = [];
    lines.push(`以下是之前 ${messages.length} 条对话的结构化摘要：`);

    for (const msg of messages) {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '[多模态内容]';
        if (content.startsWith('<system-reminder>') || content.startsWith('<context-summary>')) continue;
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
