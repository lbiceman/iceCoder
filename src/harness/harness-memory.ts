/**
 * Harness 记忆集成层（v5 — CoN + JSON 结构化读取策略）。
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
 * 10. 话题切换检测 — 多轮记忆注入（v3）
 * 11. 会话记忆响应验证 — 写入前校验 10-section 格式（v3）
 * 12. 被动确认 — 提取后通知用户记住了什么（v4）
 * 13. 偏好正则扩充 — 祈使句 + 否定偏好 + 风格偏好（v4）
 * 14. CoN + JSON 结构化读取 — 读取完整记忆内容，JSON 格式呈现，
 *     Chain-of-Note 指令要求先提取再推理（v5 新增，基于 LongMemEval ICLR 2025）
 */

import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import type { UnifiedMessage } from '../llm/types.js';
import type { LLMAdapterInterface } from '../llm/types.js';
import type { FileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import { scanMemoryFiles, memoryAge } from '../memory/file-memory/index.js';
import { recallRelevantMemories } from '../memory/file-memory/memory-recall.js';
import { getMemoryDecayStatus } from '../memory/file-memory/memory-age.js';
import { LLMMemoryExtractor } from '../memory/file-memory/memory-llm-extractor.js';
import { MemoryDream } from '../memory/file-memory/memory-dream.js';
import { getMemoryTelemetry } from '../memory/file-memory/memory-telemetry.js';
import type { MemoryTelemetry } from '../memory/file-memory/memory-telemetry.js';
import { isWithinMemoryDir } from '../memory/file-memory/memory-security.js';
import {
  MEMORY_MAX_RELEVANT,
  EXTRACTION_SIGNAL_WORDS,
} from '../memory/file-memory/memory-config.js';

/**
 * 内容启发式模式 — 检测用户消息中暗示偏好/习惯的关键词。
 * 匹配到这些模式时，即使消息很短也触发提取。
 * 覆盖：编程语言、框架、工具链、工作流偏好。
 */
const CONTENT_HEURISTIC_PATTERNS: RegExp[] = [
  // 编程语言（"用 TS 写"、"python 脚本"、"java 项目"）
  /\b(typescript|javascript|python|java|golang|rust|ruby|swift|kotlin|dart|php|c\+\+|c#)\b/i,
  /\b(ts|js|py|go|rb)\b/,
  // 框架/库（"react 组件"、"vue 页面"、"express 路由"）
  /\b(react|vue|angular|svelte|next\.?js|nuxt|express|fastify|django|flask|spring|nest\.?js)\b/i,
  // 工具链（"用 vite"、"webpack 配置"、"docker 部署"）
  /\b(vite|webpack|rollup|esbuild|docker|kubernetes|nginx|pm2|jest|vitest|mocha|pytest)\b/i,
  // 数据库（"mysql 查询"、"redis 缓存"）
  /\b(mysql|postgres|mongodb|redis|sqlite|elasticsearch)\b/i,
  // 工作流偏好（"我喜欢"、"我习惯"、"我一般"、"我通常"）
  /我(喜欢|习惯|一般|通常|倾向|偏好)/,
  // 角色/身份（"我是前端"、"我做后端"、"我负责"）
  /我(是|做|负责|在做|主要)/,
  // 英文偏好表达
  /\b(i prefer|i usually|i always|i like to|my workflow)\b/i,

  // ── v4 新增：祈使句 + 否定偏好 + 风格偏好 ──

  // 祈使句偏好（"别用分号"、"不要用 var"、"以后不要加注释"、"每次都加 JSDoc"）
  /(?:别|不要|不用|禁止|停止|以后不要?|以后别).{0,15}(?:用|写|加|做|改|放|搞|弄)/,
  /(?:每次|总是|一定要?|务必|必须|始终).{0,15}(?:用|写|加|做|改|放|检查|确认)/,
  // 风格偏好（"代码要简洁"、"注释用中文"、"变量名用驼峰"）
  /(?:代码|注释|变量名?|函数名?|文件名?|命名|缩进|格式).{0,10}(?:要|用|写|改成|换成|统一)/,
  // 否定反馈（"这样不好"、"不是这样"、"别这么做"、"太啰嗦了"）
  /(?:不好|不对|不是这样|别这么|太啰嗦|太复杂|太简单|太长了|太短了)/,
  // 英文祈使偏好（"don't use semicolons"、"always add types"、"never use var"）
  /\b(don'?t use|never use|always use|always add|stop using|no more)\b/i,
  /\b(use .{1,20} instead|switch to|prefer .{1,20} over)\b/i,
];
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
  validateSessionMemoryContent,
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

// ─── 话题切换检测 ───

/**
 * 检测两条用户消息之间是否发生了话题切换。
 *
 * 使用 token 重叠度（Jaccard 系数）判断：
 * - 重叠度 < 0.15 → 话题切换（几乎没有共同词汇）
 * - 重叠度 >= 0.15 → 同一话题
 *
 * 支持中英文混合：英文按空格分词，中文用 bigram 滑动窗口。
 * 不需要额外 LLM 调用，纯本地计算。
 */
function hasTopicShifted(previousMessage: string, currentMessage: string): boolean {
  if (!previousMessage || !currentMessage) return false;

  const tokenize = (text: string): Set<string> => {
    const tokens = new Set<string>();
    const lower = text.toLowerCase();
    // 英文词
    for (const w of lower.split(/[^a-z0-9]+/).filter(w => w.length > 2)) {
      tokens.add(w);
    }
    // 中文 bigram
    const cjk = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g);
    if (cjk) {
      for (const seg of cjk) {
        for (let i = 0; i < seg.length - 1; i++) {
          tokens.add(seg.slice(i, i + 2));
        }
      }
    }
    return tokens;
  };

  const prevTokens = tokenize(previousMessage);
  const currTokens = tokenize(currentMessage);

  // 任一消息 token 太少（< 3），不做判断
  if (prevTokens.size < 3 || currTokens.size < 3) return false;

  // Jaccard 系数 = |A ∩ B| / |A ∪ B|
  let intersection = 0;
  for (const token of currTokens) {
    if (prevTokens.has(token)) intersection++;
  }
  const union = prevTokens.size + currTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;

  return jaccard < 0.15;
}

/**
 * 从消息历史中提取最近一条用户消息的文本内容。
 * 跳过 system-reminder 注入的消息。
 */
function getLatestUserMessage(messages: UnifiedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    // 跳过记忆注入的 system-reminder 消息
    if (content.startsWith('<system-reminder>')) continue;
    // 跳过会话笔记注入的 session-notes 消息
    if (content.startsWith('<session-notes>')) continue;
    return content;
  }
  return '';
}

// ─── CoN + JSON 结构化读取 ───

/**
 * 结构化记忆项（用于 JSON 格式注入）。
 */
interface StructuredMemoryItem {
  filename: string;
  type: string;
  description: string;
  age: string;
  freshness: 'fresh' | 'stale' | 'expired';
  confidence: number;
  recallCount: number;
  tags?: string[];
  content: string;
}

/**
 * 从 Markdown 文件内容中提取正文（跳过 frontmatter）。
 */
function extractBodyFromMarkdown(raw: string): string {
  const lines = raw.split('\n');
  let bodyStart = 0;

  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
    }
  }

  // 去除空行、纯格式行（--- 分隔线、* 时间戳行）
  return lines.slice(bodyStart)
    .map(l => l.trim())
    .filter(l => l.length > 0 && l !== '---' && !l.startsWith('*Extracted:') && !l.startsWith('*Updated:') && !l.startsWith('*保存时间:'))
    .join('\n');
}

/**
 * 构建 Chain-of-Note + JSON 结构化记忆注入提示词。
 *
 * 基于 LongMemEval 论文（ICLR 2025）的最优读取策略：
 * 1. JSON 结构化格式 — 帮助模型清晰识别每条记忆的边界和元数据
 * 2. Chain-of-Note 指令 — 要求模型先从每条记忆中提取相关信息，再基于提取的笔记推理
 *
 * 论文实验表明，CoN + JSON 比直接注入自然语言列表提升 ~10 个百分点的 QA 准确率。
 */
function buildCoNMemoryPrompt(items: StructuredMemoryItem[], recallMethod: string): string {
  const json = JSON.stringify(items, null, 2);

  return `<system-reminder>
## Recalled Memories (${items.length} items, via ${recallMethod})

\`\`\`json
${json}
\`\`\`

## How to use these memories (Chain-of-Note)

Before using any memory in your response, follow these steps:
1. **Extract**: For each memory item above, identify what information is relevant to the current query
2. **Assess freshness**: Memories marked "stale" or "expired" may be outdated — verify against current code/state before citing as fact
3. **Synthesize**: Combine the extracted notes to form your response
4. **Cite**: When your response is informed by a memory, mention which memory file it came from

Do NOT blindly trust memory content. Memories are point-in-time observations. If a memory references specific files, line numbers, or code behavior, verify against the current codebase first.
</system-reminder>`;
}

/**
 * Harness 记忆集成（v3）。
 *
 * 生命周期：
 * 1. onLoopStart(userMessage, llmAdapter) — 循环开始，启动预取
 * 2. injectMemoryContext(messages) — 工具调用后注入记忆（话题切换时重新召回）
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
  /** 上次记忆注入时的用户消息（用于话题切换检测） */
  private lastInjectionUserMessage = '';
  /** 本轮是否已注入记忆（每轮 user 消息最多注入一次） */
  private injectedForCurrentMessage = false;
  private currentMessages: UnifiedMessage[] = [];
  /** 上次提取时的消息索引（用于主代理互斥检测） */
  private lastExtractionMessageIndex = 0;
  /** 提取轮次计数器（用于节流） */
  private extractionTurnCounter = 0;
  /** 记忆目录是否存在（延迟检测，避免对不存在的目录触发提取） */
  private memoryDirExists: boolean | null = null;
  /** 被动确认队列 — 提取完成后暂存摘要，下次返回时附加给用户 */
  private _extractionNotices: string[] = [];

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
    this.injectedForCurrentMessage = false;

    // 同步检测记忆目录是否存在（只检测一次）
    if (this.memoryDirExists === null) {
      this.memoryDirExists = existsSync(this.memoryDir);
    }
    // 注意：surfacedMemoryPaths 不清空 — 跨轮次去重
    // 只在新会话时清空（构造函数中初始化为空）
    // lastInjectionUserMessage 也不清空 — 用于跨轮次话题切换检测

    // 异步预取（fire-and-forget）
    if (this.fileMemoryManager) {
      this.fileMemoryManager.prefetchMemories(userMessage).catch((err) => {
        console.debug('[harness-memory] prefetch failed:', err instanceof Error ? err.message : err);
      });
    }
  }

  /**
   * 注入记忆上下文（v5 — CoN + JSON 结构化读取策略）。
   *
   * LongMemEval 论文证明 Chain-of-Note + JSON 结构化格式是最优的读取策略，
   * 比直接注入文件列表提升 ~10 个百分点的 QA 准确率。
   *
   * 改进点：
   * - 读取召回记忆的完整内容（而非仅 filename + description）
   * - 以 JSON 结构化格式呈现每条记忆的元数据和内容
   * - 附加 Chain-of-Note 指令，要求模型先提取关键信息再推理
   * - 保留话题切换检测和跨轮次去重
   */
  async injectMemoryContext(messages: UnifiedMessage[]): Promise<void> {
    if (!this.memoryDir && !this.fileMemoryManager) return;

    // 获取当前最新的用户消息（可能是循环中途用户追加的）
    const latestUserMsg = getLatestUserMessage(messages) || this.currentUserMessage;

    // 判断是否需要注入
    if (this.injectedForCurrentMessage) {
      // 已经为当前消息注入过 → 检测话题是否切换
      if (!hasTopicShifted(this.lastInjectionUserMessage, latestUserMsg)) {
        return; // 话题未变，跳过
      }
      console.debug('[harness-memory] 检测到话题切换，重新召回记忆');
    }

    const recallCfg = getRecallConfig();

    try {
      const recallResult = await recallRelevantMemories(
        latestUserMsg,
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
        queryLength: latestUserMsg.length,
      }).catch(() => {});

      if (recallResult.memories.length > 0) {
        // ── v5: CoN + JSON 结构化读取 ──
        const memoryItems = await this.buildStructuredMemoryItems(recallResult.memories);

        // 标记为已展示
        for (const mem of recallResult.memories) {
          this.surfacedMemoryPaths.add(mem.filePath);
        }

        const method = recallResult.usedLLM ? 'LLM semantic recall' : 'keyword fallback';
        const reminder = buildCoNMemoryPrompt(memoryItems, method);
        messages.push({ role: 'user', content: reminder });
      }
    } catch (err) {
      console.debug('[harness-memory] recall failed:', err instanceof Error ? err.message : err);
    }

    this.injectedForCurrentMessage = true;
    this.lastInjectionUserMessage = latestUserMsg;
  }

  /**
   * 循环结束时调用。条件触发 LLM 提取 + 会话记忆更新 + autoDream。
   * 带主代理互斥：如果主代理已直接写入记忆，跳过后台提取。
   */
  async onLoopEnd(messages: UnifiedMessage[], turnCount: number, totalInputTokens?: number): Promise<void> {
    this.currentMessages = messages;

    // ── 主代理互斥检测 ──
    if (hasMemoryWritesSince(messages, this.lastExtractionMessageIndex, this.memoryDir)) {
      console.debug('[harness-memory] 跳过提取 — 主代理已直接写入记忆文件');
      this.lastExtractionMessageIndex = messages.length;
    } else {
      // ── 条件触发 LLM 提取（sequential 包装，防止重叠） ──
      await this.sequentialExtract(messages, turnCount);
    }

    // ── 会话记忆更新（上下文压缩前的连续性保障） ──
    if (totalInputTokens !== undefined) {
      await this.maybeUpdateSessionMemory(messages, totalInputTokens);
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
   * 获取并清空被动确认通知队列。
   * 调用方（harness / chat-ws）在返回最终回复时附加这些通知。
   *
   * 返回格式示例：["💾 已记住：你偏好 TypeScript + Vitest"]
   */
  flushExtractionNotices(): string[] {
    const notices = [...this._extractionNotices];
    this._extractionNotices = [];
    return notices;
  }

  /**
   * 清理资源。
   */
  dispose(): void {
    this.currentMessages = [];
    this.surfacedMemoryPaths.clear();
    this.llmAdapter = null;
    this._extractionNotices = [];
  }

  /**
   * 等待所有进行中的提取完成（用于优雅关闭）。
   */
  async drain(timeoutMs?: number): Promise<void> {
    await drainExtractions(this.extractionGuard, timeoutMs);
  }

  // ─── 私有方法 ───

  /**
   * 构建结构化记忆项（读取完整内容 + 元数据）。
   *
   * 为每条召回的记忆读取完整文件内容，提取 frontmatter 之后的正文，
   * 组装为 JSON 结构化格式供 CoN 读取策略使用。
   *
   * 单条记忆内容截断到 2000 字符，避免上下文爆炸。
   */
  private async buildStructuredMemoryItems(
    memories: import('../memory/file-memory/types.js').MemoryHeader[],
  ): Promise<StructuredMemoryItem[]> {
    const items: StructuredMemoryItem[] = [];
    const MAX_CONTENT_CHARS = 2000;

    for (const mem of memories) {
      let content = mem.contentPreview || '';
      // 尝试读取完整文件内容（比 300 字符 preview 更完整）
      try {
        const raw = await fs.readFile(mem.filePath, 'utf-8');
        // 跳过 frontmatter，提取正文
        content = extractBodyFromMarkdown(raw);
        if (content.length > MAX_CONTENT_CHARS) {
          content = content.substring(0, MAX_CONTENT_CHARS) + '...[truncated]';
        }
      } catch {
        // 读取失败时使用 contentPreview 回退
      }

      const decayStatus = getMemoryDecayStatus(mem);

      items.push({
        filename: mem.filename,
        type: mem.type || 'unknown',
        description: mem.description || '',
        age: memoryAge(mem.mtimeMs),
        freshness: decayStatus,
        confidence: mem.confidence,
        recallCount: mem.recallCount,
        tags: mem.tags.length > 0 ? mem.tags : undefined,
        content,
      });
    }

    return items;
  }

  /**
   * 判断是否应该触发 LLM 提取。
   *
   * 基于对话内容的启发式判断，不再依赖消息长度硬编码阈值。
   * 触发条件（任一满足）：
   * 1. 信号词触发 — 用户消息包含"记住"、"偏好"等词
   * 2. 对话深度触发 — 轮次 >= minTurns 且对话中有工具调用（说明在做实际工作）
   * 3. 内容特征触发 — 用户消息暗示了编程语言/框架/工具偏好
   */
  private shouldExtract(turnCount: number): boolean {
    if (!this.llmAdapter || !this.currentUserMessage) return false;
    // 记忆目录不存在时不触发提取（测试环境或未初始化）
    if (!this.memoryDirExists) return false;

    const cfg = getExtractionConfig();
    const msgLower = this.currentUserMessage.toLowerCase();

    // 1. 信号词触发（优先级最高，不受节流限制）
    const hasSignal = EXTRACTION_SIGNAL_WORDS.some(w => msgLower.includes(w));
    if (hasSignal) return true;

    // 2. 内容特征触发 — 检测编程语言/框架/工具相关的关键词
    //    即使消息很短（如"用 TS 写个排序"），也能触发
    const hasContentSignal = CONTENT_HEURISTIC_PATTERNS.some(p => p.test(msgLower));
    if (hasContentSignal && turnCount >= 1) return true;

    // 3. 轮次节流：每 N 个合格轮次提取一次
    this.extractionTurnCounter++;
    if (this.extractionTurnCounter < cfg.turnThrottle) return false;

    // 4. 对话深度触发 — 轮次够了就提取（不再要求消息长度）
    if (turnCount >= cfg.minTurns) {
      this.extractionTurnCounter = 0;
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

        // ── v4 被动确认：将提取摘要加入通知队列 ──
        const filenames = result.writtenPaths.map(p => path.basename(p, '.md'));
        const summary = filenames
          .map(f => f.replace(/^(user|feedback|project|reference)_/, '').replace(/_/g, ' '))
          .join(', ');
        this._extractionNotices.push(`💾 已记住：${summary}`);
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
   * v3 改进：写入前验证 LLM 响应是否符合 10-section 模板格式。
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

      // v3 改进：写入前验证响应格式
      if (response.content) {
        const validation = validateSessionMemoryContent(response.content);
        if (validation.valid) {
          const { promises: fsPromises } = await import('node:fs');
          await fsPromises.writeFile(this.sessionMemoryState.notesPath, response.content, 'utf-8');
          console.debug('[harness-memory] 会话记忆已更新');
        } else {
          console.debug(
            `[harness-memory] 会话记忆更新被拒绝 — ${validation.reason}` +
            (validation.missingSections ? ` (缺失: ${validation.missingSections.join(', ')})` : ''),
          );
          // 保留原内容不覆盖
        }
      }

      this.sessionMemoryState.tokensAtLastExtraction = currentTokenCount;
      this.sessionMemoryState.lastProcessedIndex = messages.length;
    } catch (err) {
      console.debug('[harness-memory] session memory update failed:', err instanceof Error ? err.message : err);
    } finally {
      this.sessionMemoryState.extractionInProgress = false;
    }
  }
}
