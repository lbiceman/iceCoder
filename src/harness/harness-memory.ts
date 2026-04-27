/**
 * Harness 记忆集成层（v2 — 全面优化版）。
 *
 * 优化项：
 * 1. 主代理直接写入 + 后台提取互斥（hasMemoryWritesSince）
 * 2. 记忆漂移警告（memoryFreshnessNote 已在 memory-prompt 中增强）
 * 3. 并发控制（sequential 包装 + inProgress 互斥 + trailing run）
 * 4. 锁机制（ConsolidationLock 用于 autoDream）
 * 5. 远程配置（getDynamicConfig 动态加载阈值）
 * 6. 闭包隔离（initExtractionGuard 每会话独立状态）
 * 7. 召回去重（alreadySurfaced 跨轮次去重）
 * 8. 主代理互斥（检测主代理写入记忆后跳过后台提取）
 * 9. 会话笔记连续性（SessionMemory 在压缩后保持连续性）
 */

import path from 'node:path';
import type { UnifiedMessage } from '../llm/types.js';
import type { LLMAdapterInterface } from '../llm/types.js';
import type { FileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import { scanMemoryFiles, memoryFreshnessNote } from '../memory/file-memory/index.js';
import { recallRelevantMemories } from '../memory/file-memory/memory-recall.js';
import { LLMMemoryExtractor } from '../memory/file-memory/memory-llm-extractor.js';
import { MemoryDream } from '../memory/file-memory/memory-dream.js';
import { getMemoryTelemetry } from '../memory/file-memory/memory-telemetry.js';
import type { MemoryTelemetry } from '../memory/file-memory/memory-telemetry.js';
import { isWithinMemoryDir } from '../memory/file-memory/memory-security.js';
import {
  MEMORY_MAX_RELEVANT,
  EXTRACTION_SIGNAL_WORDS,
} from '../memory/file-memory/memory-config.js';
// 新增：并发控制、远程配置、闭包隔离、会话记忆
import {
  sequential,
  initExtractionGuard,
  drainExtractions,
  type ExtractionGuardState,
} from '../memory/file-memory/memory-concurrency.js';
import {
  getExtractionConfig,
  getRecallConfig,
} from '../memory/file-memory/memory-remote-config.js';
import {
  initSessionMemoryState,
  shouldUpdateSessionMemory,
  setupSessionMemoryFile,
  buildSessionMemoryUpdatePrompt,
  getSessionMemoryContent,
  truncateSessionMemoryForCompact,
  isSessionMemoryEmpty,
  type SessionMemoryState,
} from '../memory/file-memory/session-memory.js';

/**
 * HarnessMemoryIntegration 配置。
 */
export interface HarnessMemoryConfig {
  memoryDir?: string;
  fileMemoryManager?: FileMemoryManager;
  /** 会话数据目录（用于会话笔记） */
  sessionDir?: string;
}

// ─── 主代理写入检测 ───

/**
 * 检测主代理是否在 sinceIndex 之后直接写入了记忆文件。
 * 扫描 assistant 消息中的 tool_use，检查 write_file/edit_file
 * 的 file_path 是否在记忆目录内。
 */
function hasMemoryWritesSince(
  messages: UnifiedMessage[],
  sinceIndex: number,
  memoryDir: string,
): boolean {
  for (let i = sinceIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (
        (tc.name === 'write_file' || tc.name === 'edit_file' ||
         tc.name === 'append_file') &&
        tc.arguments?.file_path
      ) {
        const filePath = String(tc.arguments.file_path);
        if (isWithinMemoryDir(filePath, memoryDir)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ─── 工具调用计数 ───

function countToolCallsSince(messages: UnifiedMessage[], sinceIndex: number): number {
  let count = 0;
  for (let i = sinceIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.toolCalls) {
      count += msg.toolCalls.length;
    }
  }
  return count;
}

function hasToolCallsInLastAssistantTurn(messages: UnifiedMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return !!(messages[i].toolCalls && messages[i].toolCalls!.length > 0);
    }
  }
  return false;
}

/**
 * Harness 记忆集成（v2）。
 *
 * 生命周期：
 * 1. onLoopStart(userMessage, llmAdapter) — 循环开始，启动预取
 * 2. injectMemoryContext(messages) — 第一轮工具调用后注入记忆（带去重）
 * 3. onLoopEnd(messages, turnCount) — 循环结束，提取 + 整合（带互斥）
 * 4. getSessionMemoryForCompact() — 压缩时获取会话笔记（保持连续性）
 * 5. dispose() — 清理资源
 */
export class HarnessMemoryIntegration {
  private memoryDir: string;
  private fileMemoryManager?: FileMemoryManager;
  private telemetry: MemoryTelemetry;

  // ── 闭包隔离的状态 ──
  private extractionGuard: ExtractionGuardState;
  private sessionMemoryState: SessionMemoryState;

  // ── 每次 dream 使用新实例（闭包隔离） ──
  private memoryDream: MemoryDream;
  // ── 每次提取使用新实例（闭包隔离） ──
  private llmExtractor: LLMMemoryExtractor;

  // ── 运行时状态 ──
  private llmAdapter: LLMAdapterInterface | null = null;
  private currentUserMessage = '';
  /** 已展示过的记忆文件路径（跨轮次去重） */
  private surfacedMemoryPaths = new Set<string>();
  /** 是否已注入记忆（每轮只注入一次） */
  private memoryInjected = false;
  private currentMessages: UnifiedMessage[] = [];
  /** 上次提取时的消息索引（用于主代理互斥检测） */
  private lastExtractionMessageIndex = 0;
  /** 提取轮次计数器（用于节流） */
  private extractionTurnCounter = 0;

  // ── sequential 包装的提取函数 ──
  private sequentialExtract: (messages: UnifiedMessage[], turnCount: number) => Promise<void>;

  constructor(config: HarnessMemoryConfig) {
    this.memoryDir = config.memoryDir || 'data/memory-files';
    this.fileMemoryManager = config.fileMemoryManager;
    this.telemetry = getMemoryTelemetry();

    // 闭包隔离：每个 HarnessMemoryIntegration 实例有独立状态
    this.extractionGuard = initExtractionGuard();
    this.sessionMemoryState = initSessionMemoryState(
      config.sessionDir || 'data/sessions',
    );
    this.memoryDream = new MemoryDream();
    this.llmExtractor = new LLMMemoryExtractor({ enablePromptCache: true });

    // 并发控制：sequential 包装确保提取不重叠
    this.sequentialExtract = sequential(
      async (messages: UnifiedMessage[], turnCount: number) => {
        await this._extractMemoriesImpl(messages, turnCount);
      },
    );
  }

  get enabled(): boolean {
    return !!(this.memoryDir || this.fileMemoryManager);
  }

  // ─── 生命周期方法 ───

  /**
   * 循环开始时调用。保存用户消息，启动异步预取。
   */
  onLoopStart(userMessage: string, llmAdapter: LLMAdapterInterface | null): void {
    this.currentUserMessage = userMessage;
    this.llmAdapter = llmAdapter;
    this.memoryInjected = false;
    // 注意：surfacedMemoryPaths 不清空 — 跨轮次去重
    // 只在新会话时清空（构造函数中初始化为空）

    // 异步预取（fire-and-forget）
    if (this.fileMemoryManager) {
      this.fileMemoryManager.prefetchMemories(userMessage).catch((err) => {
        console.debug('[harness-memory] prefetch failed:', err instanceof Error ? err.message : err);
      });
    }
  }

  /**
   * 注入记忆上下文（LLM 语义召回 + 去重）。
   * 只在第一轮工具调用后注入一次。
   * alreadySurfaced 过滤已展示的文件，避免重复选择。
   */
  async injectMemoryContext(messages: UnifiedMessage[]): Promise<void> {
    if (this.memoryInjected) return;
    if (!this.memoryDir && !this.fileMemoryManager) return;

    const recallCfg = getRecallConfig();
    const sections: string[] = [];

    try {
      const recallResult = await recallRelevantMemories(
        this.currentUserMessage,
        this.memoryDir,
        this.llmAdapter,
        this.surfacedMemoryPaths, // 跨轮次去重
        recallCfg.maxResults || MEMORY_MAX_RELEVANT,
      );

      this.telemetry.logRecall({
        candidateCount: recallResult.memories.length + this.surfacedMemoryPaths.size,
        selectedCount: recallResult.memories.length,
        usedLLM: recallResult.usedLLM,
        durationMs: recallResult.duration,
        selectedFiles: recallResult.memories.map(m => m.filename),
        queryLength: this.currentUserMessage.length,
      }).catch(() => {});

      if (recallResult.memories.length > 0) {
        const parts: string[] = [];
        for (const mem of recallResult.memories) {
          const freshness = memoryFreshnessNote(mem.mtimeMs);
          const desc = mem.description ? `: ${mem.description}` : '';
          parts.push(`${freshness}- ${mem.filename}${desc}`);
          this.surfacedMemoryPaths.add(mem.filePath);
        }
        const method = recallResult.usedLLM ? 'LLM 语义召回' : '关键词匹配';
        sections.push(`相关记忆文件（${method}）：\n${parts.join('\n')}`);
      }
    } catch (err) {
      console.debug('[harness-memory] recall failed:', err instanceof Error ? err.message : err);
    }

    if (sections.length > 0) {
      const reminder = `<system-reminder>\n${sections.join('\n\n')}\n</system-reminder>`;
      messages.push({ role: 'user', content: reminder });
    }

    this.memoryInjected = true;
  }

  /**
   * 循环结束时调用。条件触发 LLM 提取 + autoDream。
   * 带主代理互斥：如果主代理已直接写入记忆，跳过后台提取。
   */
  async onLoopEnd(messages: UnifiedMessage[], turnCount: number): Promise<void> {
    this.currentMessages = messages;

    // ── 主代理互斥检测 ──
    // 如果主代理在上次提取后直接写入了记忆文件，跳过后台提取
    // 并推进 cursor，避免下次提取重复处理这些消息
    if (hasMemoryWritesSince(messages, this.lastExtractionMessageIndex, this.memoryDir)) {
      console.debug('[harness-memory] 跳过提取 — 主代理已直接写入记忆文件');
      this.lastExtractionMessageIndex = messages.length;
      // 仍然执行 dream（dream 不受主代理写入影响）
    } else {
      // ── 条件触发 LLM 提取（sequential 包装，防止重叠） ──
      await this.sequentialExtract(messages, turnCount);
    }

    // ── autoDream 整合 ──
    this.memoryDream.recordSession();
    await this.maybeDream();
  }

  /**
   * 获取会话笔记内容（用于上下文压缩后注入，保持连续性）。
   */
  async getSessionMemoryForCompact(): Promise<string | null> {
    const content = await getSessionMemoryContent(this.sessionMemoryState);
    if (!content || isSessionMemoryEmpty(content)) return null;
    const { truncatedContent } = truncateSessionMemoryForCompact(content);
    return truncatedContent;
  }

  /**
   * 清理资源。
   */
  dispose(): void {
    this.currentMessages = [];
    this.surfacedMemoryPaths.clear();
    this.llmAdapter = null;
  }

  /**
   * 等待所有进行中的提取完成（用于优雅关闭）。
   */
  async drain(timeoutMs?: number): Promise<void> {
    await drainExtractions(this.extractionGuard, timeoutMs);
  }

  // ─── 私有方法 ───

  /**
   * 判断是否应该触发 LLM 提取。
   * 使用远程配置的阈值，支持动态调整。
   */
  private shouldExtract(turnCount: number): boolean {
    if (!this.llmAdapter || !this.currentUserMessage) return false;

    const cfg = getExtractionConfig();

    // 信号词触发（优先级最高，不受节流限制）
    const msgLower = this.currentUserMessage.toLowerCase();
    const hasSignal = EXTRACTION_SIGNAL_WORDS.some(w => msgLower.includes(w));
    if (hasSignal) return true;

    // 轮次节流：每 N 个合格轮次提取一次
    this.extractionTurnCounter++;
    if (this.extractionTurnCounter < cfg.turnThrottle) return false;

    // 轮次 + 长度触发
    if (turnCount >= cfg.minTurns && this.currentUserMessage.length >= 50) {
      this.extractionTurnCounter = 0; // 重置节流计数
      return true;
    }

    return false;
  }

  /**
   * 实际执行 LLM 记忆提取（由 sequential 包装调用）。
   * 带 inProgress 互斥 + trailing run 机制。
   */
  private async _extractMemoriesImpl(messages: UnifiedMessage[], turnCount: number): Promise<void> {
    if (!this.llmAdapter) return;
    if (!this.shouldExtract(turnCount)) return;

    // inProgress 互斥
    if (this.extractionGuard.inProgress) {
      // 暂存为 trailing run
      this.extractionGuard.pendingContext = { messages: [...messages], turnCount };
      console.debug('[harness-memory] 提取进行中 — 暂存为尾随请求');
      return;
    }

    this.extractionGuard.inProgress = true;
    const p = this._doExtract(messages, turnCount);
    this.extractionGuard.inFlightExtractions.add(p);

    try {
      await p;
    } finally {
      this.extractionGuard.inFlightExtractions.delete(p);
      this.extractionGuard.inProgress = false;

      // 执行尾随提取（如果有暂存的请求）
      const trailing = this.extractionGuard.pendingContext;
      this.extractionGuard.pendingContext = null;
      if (trailing) {
        console.debug('[harness-memory] 执行尾随提取');
        await this._extractMemoriesImpl(trailing.messages, trailing.turnCount);
      }
    }
  }

  /**
   * 清理消息前缀，移除会导致 DeepSeek thinking 模式报错的字段。
   * DeepSeek 要求 reasoning_content 必须回传，但 tool 消息被过滤后
   * 消息结构不完整，会触发 400 错误。
   * 解决方案：移除 reasoningContent 和 toolCalls，只保留纯文本对话。
   */
  private sanitizeConversationPrefix(messages: UnifiedMessage[]): UnifiedMessage[] {
    return messages
      .filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
      .map(m => {
        if (m.role === 'assistant') {
          // 移除 reasoningContent 和 toolCalls，只保留纯文本内容
          const { reasoningContent, toolCalls, ...rest } = m;
          return rest;
        }
        return m;
      })
      // 过滤掉没有内容的 assistant 消息（纯 tool_calls 的 assistant 消息 content 可能为空）
      .filter(m => m.role !== 'assistant' || (m.content && m.content !== ''));
  }

  /**
   * 执行实际的 LLM 提取调用。
   */
  private async _doExtract(messages: UnifiedMessage[], _turnCount: number): Promise<void> {
    if (!this.llmAdapter) return;

    try {
      const conversationPrefix = this.sanitizeConversationPrefix(messages);
      const recentMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-20);

      if (recentMessages.length === 0) return;

      const result = await this.llmExtractor.extract(
        recentMessages,
        this.memoryDir,
        this.llmAdapter,
        conversationPrefix.length > 0 ? conversationPrefix : undefined,
      );

      // 推进 cursor
      this.lastExtractionMessageIndex = messages.length;

      this.telemetry.logExtract({
        messageCount: recentMessages.length,
        extractedCount: result.writtenPaths.length,
        usedPromptCache: result.usedPromptCache,
        contextPrefixLength: conversationPrefix.length,
        durationMs: result.duration,
        writtenFiles: result.writtenPaths.map(p => path.basename(p)),
      }).catch(() => {});

      if (result.writtenPaths.length > 0) {
        const cacheNote = result.usedPromptCache
          ? `(prefix=${conversationPrefix.length} msgs, cache ${result.cacheActuallyHit ? 'HIT' : 'MISS'})`
          : '';
        console.log(`[harness-memory] LLM 提取: ${result.writtenPaths.length} 条记忆已保存 ${cacheNote}`);
      }
    } catch (err) {
      console.debug('[harness-memory] extraction failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * 条件触发 autoDream 整合（已使用 ConsolidationLock）。
   */
  private async maybeDream(): Promise<void> {
    if (!this.llmAdapter) return;

    try {
      const shouldDream = await this.memoryDream.shouldDream(this.memoryDir);
      if (!shouldDream) return;

      const conversationPrefix = this.sanitizeConversationPrefix(this.currentMessages);

      let fileCountBefore = 0;
      try {
        const existing = await scanMemoryFiles(this.memoryDir, 500);
        fileCountBefore = existing.length;
      } catch (err) {
        console.debug('[harness-memory] scan before dream failed:', err instanceof Error ? err.message : err);
      }

      const dreamResult = await this.memoryDream.dream(
        this.memoryDir,
        this.llmAdapter,
        conversationPrefix.length > 0 ? conversationPrefix : undefined,
      );

      this.telemetry.logDream({
        executed: dreamResult.executed,
        fileCountBefore,
        filesModified: dreamResult.filesModified,
        filesDeleted: dreamResult.filesDeleted,
        durationMs: dreamResult.duration,
        trigger: 'session_interval',
      }).catch(() => {});

      if (dreamResult.executed) {
        console.log(
          `[harness-memory] autoDream: ${dreamResult.summary} ` +
          `(${dreamResult.filesModified} 修改, ${dreamResult.filesDeleted} 删除, ${dreamResult.duration}ms)`,
        );
      }
    } catch (err) {
      console.debug('[harness-memory] dream failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * 条件触发会话记忆更新。
   */
  async maybeUpdateSessionMemory(
    messages: UnifiedMessage[],
    currentTokenCount: number,
  ): Promise<void> {
    if (!this.llmAdapter) return;

    const toolCallsSince = countToolCallsSince(messages, this.sessionMemoryState.lastProcessedIndex);
    const hasToolCalls = hasToolCallsInLastAssistantTurn(messages);

    if (!shouldUpdateSessionMemory(
      this.sessionMemoryState,
      currentTokenCount,
      toolCallsSince,
      hasToolCalls,
    )) {
      return;
    }

    this.sessionMemoryState.extractionInProgress = true;
    try {
      const currentNotes = await setupSessionMemoryFile(this.sessionMemoryState);
      const prompt = buildSessionMemoryUpdatePrompt(currentNotes, this.sessionMemoryState.notesPath);

      // 使用 LLM 更新会话笔记（清理 reasoningContent/toolCalls 防止 DeepSeek 报错）
      const sanitizedPrefix = this.sanitizeConversationPrefix(messages).slice(-50);
      const response = await this.llmAdapter.chat(
        [
          ...sanitizedPrefix,
          { role: 'user', content: prompt },
        ],
        { maxTokens: 4096, temperature: 0 },
      );

      // 将更新后的内容写入文件
      if (response.content) {
        // 提取 write_file 内容或直接使用响应
        const { promises: fsPromises } = await import('node:fs');
        await fsPromises.writeFile(this.sessionMemoryState.notesPath, response.content, 'utf-8');
      }

      this.sessionMemoryState.tokensAtLastExtraction = currentTokenCount;
      this.sessionMemoryState.lastProcessedIndex = messages.length;
      console.debug('[harness-memory] 会话记忆已更新');
    } catch (err) {
      console.debug('[harness-memory] session memory update failed:', err instanceof Error ? err.message : err);
    } finally {
      this.sessionMemoryState.extractionInProgress = false;
    }
  }
}
