/**
 * 只读子代理运行器：独立消息循环、工具白名单、结果摘要与进程内缓存。
 * 供主 Harness 在执行 `delegate_to_subagent` 时调用，不修改主会话历史。
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ToolCall, ToolDefinition, UnifiedMessage } from '../llm/types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ChatFunction } from './types.js';
import { normalizeMessages } from './context-assembler.js';

/** 单次委派请求：任务描述与可选约束。 */
export interface SubAgentRequest {
  /** 子代理要完成的只读探索任务说明 */
  task: string;
  /** 可选背景，并入子侧 user 消息 */
  context?: string;
  /** 子循环最大轮次，默认 {@link DEFAULT_MAX_ROUNDS} */
  maxRounds?: number;
  /** 子循环总超时（毫秒），默认 {@link DEFAULT_TIMEOUT_MS} */
  timeoutMs?: number;
  /** 允许的 LLM 工具名；未传则用默认只读三件套 */
  tools?: string[];
  /** 路径前缀白名单；未传则仅校验工作区相对路径 */
  allowedPaths?: string[];
}

/** 子代理结束后的结构化结果，用于格式化为主会话一条 tool 结果。 */
export interface SubAgentResult {
  summary: string;
  /** 成功读取过的相对路径列表 */
  filesRead: string[];
  toolCallCount: number;
  roundsUsed: number;
  tokensUsed: number;
  status: 'completed' | 'max_rounds' | 'timeout' | 'error';
  error?: string;
  recommendedAction?: 'use_summary' | 'reread_files';
}

/** 构造 {@link SubAgentRunner} 的依赖。 */
interface SubAgentRunnerOptions {
  /** 与主会话共享的执行器（在包装层做只读校验与输出截断） */
  toolExecutor: ToolExecutor;
  /** 主会话当前工具定义列表，用于筛出子集传给子 LLM */
  toolDefinitions: ToolDefinition[];
  /** 与主 Harness 相同的 chat 调用签名 */
  chatFn: ChatFunction;
  /** 解析 `filesRead` 的 mtime、缓存失效；默认 `process.cwd()` */
  workspaceRoot?: string;
}

/** 子循环默认最大推理轮次 */
const DEFAULT_MAX_ROUNDS = 10;
/** 子循环默认总超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60_000;
/** MVP 默认只允许读文件、搜代码、列目录 */
const DEFAULT_ALLOWED_TOOLS = new Set(['read_file', 'search_codebase', 'fs_operation']);
/** 子代理侧单条工具结果字符上限（与 read 截断共用） */
const MAX_TOOL_RESULT_CHARS = 8_000;
/** 子代理侧 read_file 注入上下文的最多行数 */
const MAX_READ_FILE_LINES = 200;
/** 子代理侧 search_codebase 最多保留的匹配块数 */
const MAX_SEARCH_RESULTS = 20;
/** 子代理侧每条搜索匹配块最多字符数 */
const MAX_SEARCH_RESULT_CHARS = 500;

/** 内存缓存中的一条记录：按 task 维度分组，组内可按 filesRead 区分多条。 */
interface SubAgentCacheEntry {
  /** {@link SubAgentRunner.cacheEntryKey} 的哈希，唯一标识 task + filesRead */
  key: string;
  result: SubAgentResult;
  /** 缓存命中时用于校验工作区文件是否仍为同一时间戳 */
  mtimes: Record<string, number>;
  /** LRU：命中或写入时更新；全局超上限时淘汰最久未访问的条目 */
  lastAccessMs: number;
}

/** taskKey → 该任务下最多 10 条不同 filesRead 组合的缓存条目 */
const subAgentCache = new Map<string, SubAgentCacheEntry[]>();

/** 全局缓存条目数上限默认值；可用环境变量覆盖 */
const DEFAULT_SUBAGENT_CACHE_MAX_ENTRIES = 100;

/** 读取 `ICE_SUBAGENT_CACHE_MAX_ENTRIES`，非法则回退默认值。 */
function getSubAgentCacheMaxEntries(): number {
  const raw = process.env.ICE_SUBAGENT_CACHE_MAX_ENTRIES;
  if (raw == null || raw === '') return DEFAULT_SUBAGENT_CACHE_MAX_ENTRIES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_SUBAGENT_CACHE_MAX_ENTRIES;
}

/**
 * 合并所有 taskKey 下的条目数，超过全局上限时按 lastAccessMs 升序淘汰（最久未访问先删）。
 */
function pruneSubAgentCacheGlobally(): void {
  const max = getSubAgentCacheMaxEntries();
  let total = 0;
  for (const arr of subAgentCache.values()) total += arr.length;
  if (total <= max) return;

  type Row = { taskKey: string; entryKey: string; lastAccessMs: number };
  const rows: Row[] = [];
  for (const [taskKey, arr] of subAgentCache) {
    for (const e of arr) {
      rows.push({ taskKey, entryKey: e.key, lastAccessMs: e.lastAccessMs || 0 });
    }
  }
  rows.sort((a, b) => a.lastAccessMs - b.lastAccessMs);

  let remaining = total - max;
  for (const row of rows) {
    if (remaining <= 0) break;
    const arr = subAgentCache.get(row.taskKey);
    if (!arr?.length) continue;
    const idx = arr.findIndex(e => e.key === row.entryKey);
    if (idx < 0) continue;
    arr.splice(idx, 1);
    if (arr.length === 0) subAgentCache.delete(row.taskKey);
    remaining--;
  }
}

/** 测试或进程退出前可调用，避免 Map 在单测间串状态 */
export function clearSubAgentCacheForTests(): void {
  subAgentCache.clear();
}

/** 主会话注册用的 `delegate_to_subagent` 工具定义（英文 description 供模型阅读）。 */
export function createDelegateToSubagentToolDefinition(): ToolDefinition {
  return {
    name: 'delegate_to_subagent',
    description: [
      'Delegate a read-only codebase exploration task to an isolated sub-agent.',
      'Use this when you need to search or read multiple files but only need a concise structured summary back.',
      'The sub-agent can only use read-only tools and cannot write files, run commands, or delegate again.',
      'Prefer this tool over read_file/search_codebase when exploring unfamiliar code. It isolates context and returns a clean summary.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Detailed read-only exploration task for the sub-agent.',
        },
        context: {
          type: 'string',
          description: 'Optional extra context that helps scope the exploration.',
        },
      },
      required: ['task'],
    },
  };
}

/**
 * 在工具列表末尾追加 `delegate_to_subagent`（若尚未存在）。
 * 若 `tools.length === 0`（运行时禁用工具）则不追加，与 Harness 行为一致。
 */
export function ensureDelegateToSubagentTool(tools: ToolDefinition[]): ToolDefinition[] {
  if (tools.length === 0) return tools;
  if (tools.some(t => t.name === 'delegate_to_subagent')) return tools;
  return [...tools, createDelegateToSubagentToolDefinition()];
}

/** 将 {@link SubAgentResult} 拼成主会话 tool 消息中的多行文本。 */
export function formatSubAgentResult(result: SubAgentResult): string {
  return [
    '[SubAgent Result]',
    `status: ${result.status}`,
    `roundsUsed: ${result.roundsUsed}`,
    `toolCallCount: ${result.toolCallCount}`,
    `tokensUsed: ${result.tokensUsed}`,
    `filesRead: ${result.filesRead.length > 0 ? result.filesRead.join(', ') : '(none)'}`,
    `recommendedAction: ${result.recommendedAction ?? 'use_summary'}`,
    result.error ? `error: ${result.error}` : undefined,
    '',
    'summary:',
    result.summary || '(empty summary)',
  ].filter((line): line is string => line !== undefined).join('\n');
}

/**
 * 只读子代理：独立 system/user 起始消息，循环调用 `chatFn`，仅执行允许的只读工具。
 */
export class SubAgentRunner {
  private readonly toolExecutor: ToolExecutor;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly chatFn: ChatFunction;
  private readonly workspaceRoot: string;

  constructor(options: SubAgentRunnerOptions) {
    this.toolExecutor = options.toolExecutor;
    this.toolDefinitions = options.toolDefinitions;
    this.chatFn = options.chatFn;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
  }

  /**
   * 先查进程内缓存；未命中则跑子循环，结束后视情况写入缓存。
   * 外层 `withTimeout` 与轮次内时间检查共同约束总耗时。
   */
  async run(request: SubAgentRequest): Promise<SubAgentResult> {
    const cached = await this.getCachedResult(request);
    if (cached) return cached;

    const maxRounds = request.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowedTools = new Set(request.tools ?? [...DEFAULT_ALLOWED_TOOLS]);
    allowedTools.delete('delegate_to_subagent');

    const tools = this.buildToolDefinitions(allowedTools);
    /** 本次子运行中成功 read_file 的相对路径，用于结果与缓存键 */
    const filesRead = new Set<string>();
    let toolCallCount = 0;
    let roundsUsed = 0;
    let tokensUsed = 0;
    /** 最后一轮模型正文，用于超时/达上限时的尽力摘要 */
    let lastAssistantContent = '';

    const startedAt = Date.now();
    const messages: UnifiedMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: this.buildUserPrompt(request) },
    ];

    const runLoop = async (): Promise<SubAgentResult> => {
      for (let round = 1; round <= maxRounds; round++) {
        roundsUsed = round;
        if (Date.now() - startedAt >= timeoutMs) {
          return this.partialResult('timeout', lastAssistantContent, filesRead, toolCallCount, roundsUsed, tokensUsed);
        }

        const response = await this.chatFn(normalizeMessages(messages), { tools });
        tokensUsed += response.usage?.totalTokens ?? 0;

        if (response.content) lastAssistantContent = response.content;

        const toolCalls = response.toolCalls ?? [];
        if (toolCalls.length === 0) {
          return {
            summary: response.content || this.buildFallbackSummary(filesRead),
            filesRead: [...filesRead],
            toolCallCount,
            roundsUsed,
            tokensUsed,
            status: 'completed',
            recommendedAction: response.content ? 'use_summary' : 'reread_files',
          };
        }

        messages.push({
          role: 'assistant',
          content: response.content || '',
          toolCalls,
          reasoningContent: response.reasoningContent,
        });

        for (const toolCall of toolCalls) {
          toolCallCount++;
          const result = await this.executeReadOnlyTool(toolCall, allowedTools, request.allowedPaths);
          if (toolCall.name === 'read_file' && result.success) {
            const rawPath = toolCall.arguments.path || toolCall.arguments.filePath;
            if (typeof rawPath === 'string') filesRead.add(rawPath);
          }
          const output = result.success ? result.output : `工具执行错误: ${result.error}`;
          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: truncateSubAgentToolOutput(toolCall.name, output),
          });
        }
      }

      return this.partialResult('max_rounds', lastAssistantContent, filesRead, toolCallCount, roundsUsed, tokensUsed);
    };

    try {
      const result = await withTimeout(runLoop(), timeoutMs);
      await this.cacheResult(request, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'subagent_timeout' ? 'timeout' : 'error';
      return {
        ...this.partialResult(status, lastAssistantContent, filesRead, toolCallCount, roundsUsed, tokensUsed),
        error: status === 'error' ? message : undefined,
      };
    }
  }

  /** 从主工具定义中筛出白名单，并将 `fs_operation` 限制为仅 `list`。 */
  private buildToolDefinitions(allowedTools: Set<string>): ToolDefinition[] {
    return this.toolDefinitions
      .filter(tool => allowedTools.has(tool.name) && tool.name !== 'delegate_to_subagent')
      .map(tool => tool.name === 'fs_operation' ? restrictFsOperationToList(tool) : tool);
  }

  /** 先做路径与白名单校验，再委托 `ToolExecutor`；`search_codebase` 会先收紧 `maxResults`。 */
  private async executeReadOnlyTool(
    toolCall: ToolCall,
    allowedTools: Set<string>,
    allowedPaths: string[] | undefined,
  ) {
    const guard = validateReadOnlyToolCall(toolCall, allowedTools, allowedPaths);
    if (guard) return { success: false, output: '', error: guard };
    return this.toolExecutor.executeTool(normalizeSubAgentToolCall(toolCall));
  }

  /** 按 task 维度查找缓存；命中且文件 mtime 未变则刷新 LRU 时间并返回带 cache 标记的摘要副本。 */
  private async getCachedResult(request: SubAgentRequest): Promise<SubAgentResult | undefined> {
    const entries = subAgentCache.get(this.cacheTaskKey(request));
    if (!entries?.length) return undefined;

    for (const entry of entries) {
      if (await this.isCacheEntryFresh(entry)) {
        entry.lastAccessMs = Date.now();
        return {
          ...entry.result,
          summary: `${entry.result.summary}\n\n[SubAgent cache hit]`,
        };
      }
    }

    return undefined;
  }

  /**
   * 仅缓存 `completed` 且 `filesRead` 非空、且能读到全部对应 mtime 的成功结果。
   * 同一 taskKey 下最多保留 10 条不同 `filesRead` 组合，然后做全局 LRU 裁剪。
   */
  private async cacheResult(request: SubAgentRequest, result: SubAgentResult): Promise<void> {
    if (result.status !== 'completed' || result.filesRead.length === 0) return;

    const mtimes = await this.collectFileMtimes(result.filesRead);
    if (Object.keys(mtimes).length !== result.filesRead.length) return;
    const key = this.cacheEntryKey(request, result.filesRead);
    const taskKey = this.cacheTaskKey(request);
    const entries = subAgentCache.get(taskKey)?.filter(entry => entry.key !== key) ?? [];
    const now = Date.now();
    entries.push({ key, result, mtimes, lastAccessMs: now });
    subAgentCache.set(taskKey, entries.slice(-10));
    pruneSubAgentCacheGlobally();
  }

  /** 比较缓存写入时记录的 mtime 与当前磁盘是否一致。 */
  private async isCacheEntryFresh(entry: SubAgentCacheEntry): Promise<boolean> {
    for (const [file, cachedMtime] of Object.entries(entry.mtimes)) {
      const currentMtime = await this.getFileMtime(file);
      if (currentMtime == null || currentMtime !== cachedMtime) return false;
    }
    return true;
  }

  /** 为 `filesRead` 中每个相对路径收集 `mtimeMs`（缺失路径则该文件不出现在 map 中）。 */
  private async collectFileMtimes(files: string[]): Promise<Record<string, number>> {
    const mtimes: Record<string, number> = {};
    for (const file of files) {
      const mtime = await this.getFileMtime(file);
      if (mtime != null) mtimes[file] = mtime;
    }
    return mtimes;
  }

  /** 相对于 `this.workspaceRoot` 解析路径后的文件修改时间。 */
  private async getFileMtime(file: string): Promise<number | undefined> {
    try {
      const stat = await fs.stat(path.resolve(this.workspaceRoot, file));
      return stat.mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** 缓存分组键：task / context / allowedPaths / tools 的稳定哈希。 */
  private cacheTaskKey(request: SubAgentRequest): string {
    return stableHash({
      task: request.task,
      context: request.context ?? '',
      allowedPaths: request.allowedPaths ?? [],
      tools: request.tools ?? [...DEFAULT_ALLOWED_TOOLS],
    });
  }

  /** 单条缓存键：在 taskKey 基础上再包含排序后的 `filesRead`。 */
  private cacheEntryKey(request: SubAgentRequest, filesRead: string[]): string {
    return stableHash({
      taskKey: this.cacheTaskKey(request),
      filesRead: [...filesRead].sort(),
    });
  }

  /** 子代理 system：角色约束 + 摘要段落格式（英文，利模型遵循）。 */
  private buildSystemPrompt(): string {
    return [
      'You are a read-only exploration sub-agent for iceCoder.',
      'You may inspect files and search the codebase, but you must not write files, run shell commands, apply patches, or delegate to another agent.',
      'Return a concise structured summary when you have enough information.',
      '',
      'Summary format:',
      '1. Core findings: 1-3 sentences.',
      '2. Key files and responsibilities: bullet list with paths.',
      '3. Important logic or dependencies: only if relevant.',
      '4. Coverage gaps: say what was not inspected or what should be reread by the main agent.',
    ].join('\n');
  }

  /** 子代理首条 user：任务、可选 context 与 allowedPaths。 */
  private buildUserPrompt(request: SubAgentRequest): string {
    return [
      `Task: ${request.task}`,
      request.context ? `Context:\n${request.context}` : undefined,
      request.allowedPaths?.length ? `Allowed paths: ${request.allowedPaths.join(', ')}` : undefined,
    ].filter((part): part is string => !!part).join('\n\n');
  }

  /** 超时、触顶轮次或非 `subagent_timeout` 异常时的尽力摘要构造。 */
  private partialResult(
    status: 'max_rounds' | 'timeout' | 'error',
    lastAssistantContent: string,
    filesRead: Set<string>,
    toolCallCount: number,
    roundsUsed: number,
    tokensUsed: number,
  ): SubAgentResult {
    const summary = lastAssistantContent?.trim()
      ? `${lastAssistantContent.trim()}\n\n[SubAgent stopped early: ${status}. The summary may be incomplete.]`
      : this.buildFallbackSummary(filesRead, status);
    return {
      summary,
      filesRead: [...filesRead],
      toolCallCount,
      roundsUsed,
      tokensUsed,
      status,
      recommendedAction: status === 'max_rounds' || status === 'timeout' ? 'reread_files' : 'use_summary',
    };
  }

  /** 模型未产出正文时的兜底说明。 */
  private buildFallbackSummary(filesRead: Set<string>, status?: string): string {
    const files = [...filesRead];
    return [
      status ? `Sub-agent stopped with status: ${status}.` : 'Sub-agent did not produce a detailed summary.',
      files.length > 0 ? `Files read: ${files.join(', ')}` : 'No files were read.',
      'The main agent should continue exploration if the task needs more detail.',
    ].join('\n');
  }
}

/**
 * 校验单次工具调用是否符合只读白名单与路径策略。
 * @returns 违反时返回中文错误文案，通过则 `undefined`
 */
function validateReadOnlyToolCall(
  toolCall: ToolCall,
  allowedTools: Set<string>,
  allowedPaths: string[] | undefined,
): string | undefined {
  if (!allowedTools.has(toolCall.name) || toolCall.name === 'delegate_to_subagent') {
    return `只读子代理不允许调用 ${toolCall.name}`;
  }

  if (toolCall.name === 'fs_operation' && toolCall.arguments.operation !== 'list') {
    return '只读子代理只允许 fs_operation 的 list 操作';
  }

  const pathsToCheck = [
    toolCall.arguments.path,
    toolCall.arguments.filePath,
    toolCall.arguments.directory,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const candidate of pathsToCheck) {
    const pathError = validateRelativePath(candidate, allowedPaths);
    if (pathError) return pathError;
  }

  return undefined;
}

/**
 * 单路径：`allowedPaths` 非空则要求落在某一前缀下；禁止绝对路径与 `..` 逃逸。
 */
function validateRelativePath(candidate: string, allowedPaths: string[] | undefined): string | undefined {
  if (path.isAbsolute(candidate)) {
    return `只读子代理只能访问工作区相对路径: ${candidate}`;
  }
  const normalized = normalizePath(candidate);
  if (normalized === '..' || normalized.startsWith('../')) {
    return `只读子代理不允许访问工作区外路径: ${candidate}`;
  }
  if (!allowedPaths?.length || normalized === '.') return undefined;

  const allowed = allowedPaths.map(normalizePath);
  const inAllowedPath = allowed.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
  return inAllowedPath ? undefined : `路径不在子代理 allowedPaths 范围内: ${candidate}`;
}

/** 统一为 POSIX 风格相对片段，便于前缀匹配。 */
function normalizePath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  return normalized.replace(/^\.\//, '') || '.';
}

/** 克隆 schema 并将 `operation` 枚举改为仅 `list`，避免子代理误传写操作。 */
function restrictFsOperationToList(tool: ToolDefinition): ToolDefinition {
  const parameters = structuredClone(tool.parameters);
  const operation = parameters?.properties?.operation;
  if (operation && typeof operation === 'object') {
    operation.enum = ['list'];
    operation.description = 'Only "list" is allowed inside read-only sub-agents.';
  }
  return {
    ...tool,
    description: 'Read-only directory listing. In sub-agents, fs_operation only supports operation: "list".',
    parameters,
  };
}

/** 子代理内强制收紧 `search_codebase` 的 `maxResults` 上限。 */
function normalizeSubAgentToolCall(toolCall: ToolCall): ToolCall {
  if (toolCall.name !== 'search_codebase') return toolCall;
  const currentMax = Number(toolCall.arguments.maxResults);
  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      maxResults: Number.isFinite(currentMax) && currentMax > 0
        ? Math.min(currentMax, MAX_SEARCH_RESULTS)
        : MAX_SEARCH_RESULTS,
    },
  };
}

/** 按工具类型分路由到不同截断策略，仅影响注入子上下文的 tool 消息。 */
function truncateSubAgentToolOutput(toolName: string, output: string): string {
  if (toolName === 'read_file') return truncateReadFileOutput(output);
  if (toolName === 'search_codebase') return truncateSearchOutput(output);
  return truncateGenericToolOutput(output);
}

/** 限制行数与总字符，减少大文件撑爆子上下文。 */
function truncateReadFileOutput(output: string): string {
  const lines = output.split('\n');
  let body = lines.length > MAX_READ_FILE_LINES
    ? lines.slice(0, MAX_READ_FILE_LINES).join('\n')
    : output;
  let truncated = body.length !== output.length;

  if (body.length > MAX_TOOL_RESULT_CHARS) {
    body = body.slice(0, MAX_TOOL_RESULT_CHARS);
    const lastNewline = body.lastIndexOf('\n');
    if (lastNewline > MAX_TOOL_RESULT_CHARS * 0.4) body = body.slice(0, lastNewline);
    truncated = true;
  }

  return truncated
    ? `${body}\n\n[... truncated by SubAgent: read_file output limited to ${MAX_READ_FILE_LINES} lines / ${MAX_TOOL_RESULT_CHARS} chars ...]`
    : output;
}

/** 按空行分块视为搜索匹配块，限制块数与每块长度。 */
function truncateSearchOutput(output: string): string {
  const blocks = output.split(/\n{2,}/);
  const kept = blocks.slice(0, MAX_SEARCH_RESULTS).map(block => (
    block.length > MAX_SEARCH_RESULT_CHARS
      ? `${block.slice(0, MAX_SEARCH_RESULT_CHARS)}\n[... truncated by SubAgent: search match limited to ${MAX_SEARCH_RESULT_CHARS} chars ...]`
      : block
  ));
  const truncated = blocks.length > kept.length || kept.some((block, index) => block !== blocks[index]);
  return truncated
    ? `${kept.join('\n\n')}\n\n[... truncated by SubAgent: search_codebase output limited to ${MAX_SEARCH_RESULTS} matches ...]`
    : output;
}

/** 其它只读工具的通用字符上限。 */
function truncateGenericToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_RESULT_CHARS) return output;
  return `${output.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[SubAgent tool output truncated, original length: ${output.length} chars]`;
}

/** 缓存键：对规范化对象做 SHA256，避免键字符串过长。 */
function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * 与子循环并行競态：超时抛出 `subagent_timeout`，与内层轮次时间检查互补。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('subagent_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
