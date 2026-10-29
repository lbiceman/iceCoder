/**
 * 工具结果写入上下文时的注入规模（写入时决定一次，之后不再改，保证前缀缓存）。
 *
 * - 上限按工具类别 × 上下文窗口档位（tool-output-limits），再受本轮剩余上下文约束；
 * - 能放下就原样注入；放不下时按类别裁剪：文件按连续行分页，命令留头尾，搜索/网页留开头；
 * - 本轮上下文预算用尽时只注入恢复指引（omitted），原文在落盘文件或源文件里；
 * - 每条结果记录 {@link ToolResultMeta}，用于观测、重读识别和压力清理的占位。
 */

import { DEFAULT_AGENT_MAX_OUTPUT_TOKENS } from '../config/model-capabilities.js';
import type { ToolResultMeta, ToolResultStrategy, UnifiedMessage } from '../llm/types.js';
import { estimateStringTokens } from '../llm/token-estimator.js';
import { truncateHeadTail } from '../tools/head-tail-truncate.js';
import { repageReadFileOutput, type ReadFileRange } from '../tools/read-file-page.js';
import {
  getFailedRunCommandInlineChars,
  getMaxToolOutputChars,
  getToolTokenCap,
  type ToolTokenBudgetClass,
} from '../tools/tool-output-limits.js';
import type { ContextWindowTier } from './context-window-tier.js';

export type ToolResultClass = ToolTokenBudgetClass | 'failed_command' | 'default';

export interface ToolResultBudget {
  cls: ToolResultClass;
  /** token 上限（token 类别恒有；字符类别在余量不足时也有） */
  capTokens?: number;
  /** failed_command / default 的字符上限 */
  capChars?: number;
  /** tier：档位上限；remaining：被剩余上下文收紧；chars：字符上限 */
  source: 'tier' | 'remaining' | 'chars';
}

/** 发送前为易变块（运行时状态、工作区锚点等）预留的 token；写入时它们还没生成 */
export const EPHEMERAL_RESERVE_TOKENS = 2_000;
/** 单条结果最多占本轮剩余 token 的这个比例，给同批后续结果留空间 */
const REMAINING_SHARE = 0.5;
/** 余量收紧后的参考下限；真实剩余更少时服从剩余 */
const MIN_GUARDED_TOKENS = 2_000;
/** 上限低于此值时不再裁剪内容，只注入恢复指引 */
const OMIT_BELOW_TOKENS = 300;
/** 非文件结果超过此长度就在写入时落盘，之后压缩改写视图时原文仍可找回 */
export const SPILL_ALWAYS_MIN_CHARS = 1_000;

const COMMAND_TOOLS = new Set(['run_command', 'git', 'shell_exec']);
const SEARCH_TOOLS = new Set(['grep', 'glob']);
const WEB_TOOLS = new Set(['fetch_url', 'web_search']);

export function classifyToolResult(toolName: string, success: boolean): ToolResultClass {
  if (toolName === 'run_command' && !success) return 'failed_command';
  if (!success) return 'default';
  if (toolName === 'read_file') return 'file_read';
  if (COMMAND_TOOLS.has(toolName)) return 'command';
  if (SEARCH_TOOLS.has(toolName)) return 'search';
  if (WEB_TOOLS.has(toolName)) return 'web';
  return 'default';
}

/**
 * 一次请求能放进上下文的硬上限：窗口 − 单次输出上限 − 易变块预留。
 * 系统提示、工具定义、历史和工具结果合计不能超过它。
 */
export function resolveContextHardLimit(
  contextWindowTokens: number,
  maxOutputTokens: number = DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  ephemeralReserve: number = EPHEMERAL_RESERVE_TOKENS,
): number {
  return Math.max(0, contextWindowTokens - maxOutputTokens - ephemeralReserve);
}

/** 本轮剩余 token 下单条结果的上限；剩余为 0 时为 0 */
function remainingCap(roomTokens: number): number {
  if (roomTokens <= 0) return 0;
  return Math.max(Math.floor(roomTokens * REMAINING_SHARE), Math.min(MIN_GUARDED_TOKENS, roomTokens));
}

export function resolveToolResultBudget(input: {
  toolName: string;
  success: boolean;
  contextWindowTokens: number;
  /** 已占用 token（含本批已注入的结果） */
  effectiveUsedTokens: number;
  /** 工具元数据里的字符上限（default 类别用） */
  metadataMaxChars: number;
  /** 单次输出上限（输出预留）；缺省用 Agent 默认值 */
  maxOutputTokens?: number;
  tier?: ContextWindowTier;
}): ToolResultBudget {
  const cls = classifyToolResult(input.toolName, input.success);
  const room = resolveContextHardLimit(input.contextWindowTokens, input.maxOutputTokens)
    - input.effectiveUsedTokens;
  const guard = remainingCap(room);

  if (cls === 'failed_command' || cls === 'default') {
    const capChars = cls === 'failed_command'
      ? getFailedRunCommandInlineChars()
      : Number.isFinite(input.metadataMaxChars)
        ? Math.min(input.metadataMaxChars, getMaxToolOutputChars())
        : getMaxToolOutputChars();
    // 中文 1 字约 1 token，字符上限对应的 token 最多就是 capChars
    if (guard < capChars) return { cls, capChars, capTokens: guard, source: 'remaining' };
    return { cls, capChars, source: 'chars' };
  }

  const tierCap = getToolTokenCap(cls, input.tier);
  if (guard < tierCap) return { cls, capTokens: guard, source: 'remaining' };
  return { cls, capTokens: tierCap, source: 'tier' };
}

export function exceedsToolResultBudget(output: string, budget: ToolResultBudget): boolean {
  if (budget.capChars !== undefined && output.length > budget.capChars) return true;
  if (budget.capTokens !== undefined) return estimateStringTokens(output) > budget.capTokens;
  return false;
}

/** 文件分页不落盘（源文件即原文）；其余类别超限都要落盘 */
export function toolResultNeedsSpill(budget: ToolResultBudget, readRange?: ReadFileRange): boolean {
  return !(budget.cls === 'file_read' && readRange);
}

/** 写入时是否落盘：超限必落；未超限但较长的非文件结果也落，供之后压缩/清理时找回 */
export function shouldSpillToolResult(
  output: string,
  budget: ToolResultBudget,
  readRange?: ReadFileRange,
): boolean {
  if (!toolResultNeedsSpill(budget, readRange)) return false;
  return output.length > SPILL_ALWAYS_MIN_CHARS || exceedsToolResultBudget(output, budget);
}

function charBudgetForTokens(text: string, capTokens: number): number {
  const tokens = Math.max(1, estimateStringTokens(text));
  return Math.max(200, Math.floor((capTokens * text.length) / tokens));
}

function headTailOmitted(textLength: number, budget: number, headRatio: number): [number, number] {
  const usable = Math.max(2, budget);
  const headLen = Math.max(1, Math.floor(usable * headRatio));
  const tailLen = Math.max(1, usable - headLen);
  return [headLen, textLength - tailLen];
}

/** 落盘原文的读取指引（read_file 接受绝对路径） */
export function spillReadHint(spillPath: string): string {
  return `read_file path="${spillPath}" with offset/limit (or grep that file)`;
}

function spillHint(spillPath: string | undefined): string {
  return spillPath
    ? `\nFull output saved to: ${spillPath}\nOnly part of the output is shown above. Read the rest with ${spillReadHint(spillPath)}.`
    : '\nThe full output was not saved; re-run the tool with narrower arguments if you need the omitted part.';
}

function headAtLineBoundary(text: string, budget: number): string {
  const cut = text.slice(0, budget);
  const lastNl = cut.lastIndexOf('\n');
  return lastNl > budget * 0.5 ? cut.slice(0, lastNl) : cut;
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** read_file 范围对应的 meta 字段（已返回行、省略行、视图格式） */
export function readFileRangeMeta(range: ReadFileRange): Partial<ToolResultMeta> {
  const omitted: Array<[number, number]> = [];
  if (range.endLine < range.requestedEnd) omitted.push([range.endLine + 1, range.requestedEnd]);
  return {
    path: range.path,
    lines: { start: range.startLine, end: range.endLine, total: range.totalLines },
    page: { numbered: range.numbered, headerLines: range.headerLines, requestedEnd: range.requestedEnd },
    ...(omitted.length ? { omittedLines: omitted } : {}),
  };
}

function omittedView(
  toolName: string,
  output: string,
  originalTokens: number,
  readRange: ReadFileRange | undefined,
  spillPath: string | undefined,
): { view: string; extra: Partial<ToolResultMeta> } {
  const lead = `[${toolName} output omitted: this round's context budget is used up (output ~${originalTokens} tokens). `
    + 'This is NOT the tool output.';
  if (readRange) {
    const end = readRange.requestedEnd;
    return {
      view: `${lead} ${readRange.path} lines ${readRange.startLine}-${end} of ${readRange.totalLines} were not shown; `
        + `read_file path=${readRange.path} offset=${readRange.startLine} with a small limit to see them.]`,
      extra: {
        path: readRange.path,
        omittedLines: [[readRange.startLine, end]],
      },
    };
  }
  const recover = spillPath
    ? `Full output saved to: ${spillPath} — read it with ${spillReadHint(spillPath)}.`
    : 'The output was not saved; re-run the tool with narrower arguments when there is room.';
  return { view: `${lead} ${recover}]`, extra: { omittedChars: [0, output.length] } };
}

export interface ShapedToolResult {
  view: string;
  meta: ToolResultMeta;
}

/**
 * 按预算生成注入视图。spillPath 为已落盘的完整原文路径（落盘失败或无需落盘时省略）。
 */
export function shapeToolResult(input: {
  toolName: string;
  output: string;
  budget: ToolResultBudget;
  readRange?: ReadFileRange;
  spillPath?: string;
}): ShapedToolResult {
  const { toolName, output, budget, readRange, spillPath } = input;
  const originalTokens = estimateStringTokens(output);
  const base = {
    toolName,
    originalChars: output.length,
    originalTokens,
    ...(spillPath ? { spillPath } : {}),
  };
  const finish = (
    view: string,
    strategy: ToolResultStrategy,
    extra: Partial<ToolResultMeta> = {},
  ): ShapedToolResult => ({
    view,
    meta: {
      ...base,
      strategy,
      injectedChars: view.length,
      injectedTokens: view === output ? originalTokens : estimateStringTokens(view),
      ...extra,
    },
  });
  const fileRead = budget.cls === 'file_read' && readRange ? readRange : undefined;

  if (!exceedsToolResultBudget(output, budget)) {
    if (fileRead) return finish(output, fileRead.capped ? 'page' : 'full', readFileRangeMeta(fileRead));
    return finish(output, 'full');
  }

  if (budget.capTokens !== undefined && budget.capTokens < OMIT_BELOW_TOKENS) {
    // 比指引还短的结果照常注入
    if (originalTokens <= OMIT_BELOW_TOKENS) {
      return fileRead ? finish(output, 'full', readFileRangeMeta(fileRead)) : finish(output, 'full');
    }
    const omitted = omittedView(toolName, output, originalTokens, fileRead, spillPath);
    return finish(omitted.view, 'omitted', omitted.extra);
  }

  if (fileRead && budget.capTokens !== undefined) {
    const paged = repageReadFileOutput(output, fileRead, budget.capTokens);
    if (paged) return finish(paged.output, 'page', readFileRangeMeta(paged.range));
  }

  if (budget.cls === 'search' || budget.cls === 'web') {
    const charBudget = charBudgetForTokens(output, budget.capTokens ?? 0);
    const head = headAtLineBoundary(output, charBudget);
    const totalLines = countLines(output);
    const shownLines = countLines(head);
    const view = `${head}\n...[输出已截断，原始长度 ${output.length} 字符，共 ${totalLines} 行，仅显示前 ${shownLines} 行]`
      + spillHint(spillPath);
    return finish(view, 'head', { omittedChars: [head.length, output.length] });
  }

  const headRatio = budget.cls === 'failed_command' ? 0.2 : 0.3;
  const tokenChars = budget.capTokens !== undefined ? charBudgetForTokens(output, budget.capTokens) : Infinity;
  const charBudget = Math.min(budget.capChars ?? Infinity, tokenChars, output.length);
  const marker = `\n...[输出已截断，原始长度 ${output.length} 字符]...${spillHint(spillPath)}\n`;
  const truncated = truncateHeadTail(output, charBudget, { headRatio, marker });
  if (truncated === output) return finish(output, 'full');
  const view = budget.cls === 'command'
    ? `Total output lines: ${countLines(output)}\n${truncated}`
    : truncated;
  return finish(view, budget.cls === 'failed_command' ? 'tail' : 'head_tail', {
    omittedChars: headTailOmitted(output.length, charBudget, headRatio),
  });
}

/** 路径比较用：统一分隔符、去掉 ./ 前缀，Windows 不区分大小写 */
export function normalizeToolPath(p: string): string {
  let out = p.trim().replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function rangesIntersect(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

export interface RereadTarget {
  toolCallId: string;
  /** paged：补读分页未返回的行；cleared：补读被清理的结果；spill：读取落盘的原文 */
  reason: 'paged' | 'cleared' | 'spill';
}

function isClearedView(msg: UnifiedMessage): boolean {
  return msg.apiSealedBy === 'pressureClear' || msg.apiSealedBy === 'compaction';
}

/**
 * 本次 read_file 是否在补读之前某条结果省略、清理掉的内容，或读取它落盘的原文。
 * 取最近的一条。lines 省略时只按落盘路径匹配。
 */
export function findRereadTarget(
  messages: UnifiedMessage[],
  path: string,
  lines?: [number, number],
): RereadTarget | null {
  const target = normalizeToolPath(path);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const meta = msg.toolResultMeta;
    if (msg.role !== 'tool' || !msg.toolCallId || !meta) continue;
    if (meta.spillPath && normalizeToolPath(meta.spillPath) === target) {
      return { toolCallId: msg.toolCallId, reason: 'spill' };
    }
    if (!lines || meta.toolName !== 'read_file' || !meta.path) continue;
    if (normalizeToolPath(meta.path) !== target) continue;
    if (isClearedView(msg) && meta.lines
      && rangesIntersect([meta.lines.start, meta.lines.end], lines)) {
      return { toolCallId: msg.toolCallId, reason: 'cleared' };
    }
    if (meta.omittedLines?.some(range => rangesIntersect(range, lines))) {
      return { toolCallId: msg.toolCallId, reason: 'paged' };
    }
  }
  return null;
}

export interface LiveToolResultSavings {
  /** 当前历史里写入时裁剪省下的 token（原始 − 注入） */
  shapedSavedTokens: number;
  /** 当前历史里清理 / 压缩缩短视图省下的 token */
  clearedSavedTokens: number;
  /** 当前历史里补读结果占用的 token */
  rereadTokens: number;
  shapedResults: number;
  clearedResults: number;
  rereadResults: number;
}

/**
 * 写入时裁剪省下的 token。read_file 自己分页时原文就是这一页，
 * 按「省略行数 × 已返回行的平均 token」估算没发出去的部分。
 */
function shapedSavedTokens(meta: ToolResultMeta): number {
  const direct = Math.max(0, meta.originalTokens - meta.injectedTokens);
  if (direct > 0 || meta.toolName !== 'read_file' || !meta.lines || !meta.omittedLines?.length) return direct;
  const returned = meta.lines.end - meta.lines.start + 1;
  if (returned <= 0) return 0;
  const omitted = meta.omittedLines.reduce((sum, [a, b]) => sum + Math.max(0, b - a + 1), 0);
  return Math.round((omitted * meta.injectedTokens) / returned);
}

/**
 * 统计当前历史里仍生效的节省与补读占用。每次调用模型前算一次，累加即为整段会话的
 * 实际节省（被裁剪的结果每轮都随历史重发，省下的 token 也每轮都省）。
 */
export function measureLiveToolResultSavings(messages: UnifiedMessage[]): LiveToolResultSavings {
  const out: LiveToolResultSavings = {
    shapedSavedTokens: 0,
    clearedSavedTokens: 0,
    rereadTokens: 0,
    shapedResults: 0,
    clearedResults: 0,
    rereadResults: 0,
  };
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const meta = msg.toolResultMeta;
    if (isClearedView(msg) && typeof msg.apiSealedContent === 'string') {
      const before = meta?.originalTokens
        ?? (typeof msg.content === 'string' ? estimateStringTokens(msg.content) : 0);
      out.clearedSavedTokens += Math.max(0, before - estimateStringTokens(msg.apiSealedContent));
      out.clearedResults++;
      continue;
    }
    if (!meta) continue;
    if (meta.strategy !== 'full' && meta.strategy !== 'range_error') {
      out.shapedSavedTokens += shapedSavedTokens(meta);
      out.shapedResults++;
    }
    if (meta.rereadOf) {
      out.rereadTokens += meta.injectedTokens;
      out.rereadResults++;
    }
  }
  return out;
}
