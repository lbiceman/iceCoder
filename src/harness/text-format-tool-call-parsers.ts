/**
 * 从 assistant 正文中识别「嵌入的工具调用」——不绑定某一模型格式。
 * 支持：XML 块、JSON 对象、Markdown fenced JSON、未闭合 XML 尾块。
 */

import { randomUUID } from 'node:crypto';
import type { ToolCall } from '../llm/types.js';
import { stripEmbeddedThinking } from './thinking-content-strip.js';

export interface TextSpan {
  start: number;
  end: number;
}

export interface ParsedEmbeddedToolCalls {
  calls: ToolCall[];
  spans: TextSpan[];
}

const XML_BLOCK_RES: readonly RegExp[] = [
  /<tool_call>([\s\S]*?)<\/tool_call>/gi,
  /<tool-call>([\s\S]*?)<\/tool-call>/gi,
  /<invoke\b[^>]*>([\s\S]*?)<\/invoke>/gi,
];

const XML_FUNCTION_NAME_RES: readonly RegExp[] = [
  /<function=([\w.-]+)>/i,
  /<function\s+name=["']([\w.-]+)["']/i,
  /<name>([\w.-]+)<\/name>/i,
];

const XML_PARAM_RES = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/gi;
const XML_ARG_PAIR_RES = /<(?:arg|parameter)\s+name=["']([\w.-]+)["'][^>]*>([\s\S]*?)<\/(?:arg|parameter)>/gi;
/** 部分模型用方括号包裹参数，如 [<task_id>bg_xxx]（排除 [</tag>] 闭合行） */
const BRACKET_PARAM_RE = /\[<(?!\/)([a-zA-Z_][\w.-]*)>([^\]]*)\]/gi;
/** 通道分隔符（各厂商命名不同，形态多为 <]token[>） */
const CHANNEL_DELIMITER_RE = /<\][a-zA-Z][\w.-]*\[>/g;
/** 完整工具调用区域（闭合块） */
const TOOL_INVOCATION_REGION_RE =
  /(?:<tool[_-]?call>|<invoke\b|<\][a-zA-Z][\w.-]*\[>)([\s\S]*?)(?:<\/tool[_-]?call>|<\/invoke>)/gi;
/** 压缩/展示用的「调用工具」摘要前缀（后常粘连未剥离的嵌入片段） */
const COMPACT_TOOL_SUMMARY_RE = /\[调用工具:\s*[\w.,\s-]+\]+/g;

const TOOL_JSON_KEY_HINT =
  /"(?:name|tool|function_name)"\s*:\s*"|"tool_calls"\s*:\s*\[|"function"\s*:\s*\{/;

const FENCED_JSON_RE = /```(?:json|tool_call|tools?)?\s*\n([\s\S]*?)```/gi;

function newSalvagedCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `salvaged-${randomUUID()}`,
    name,
    arguments: args,
  };
}

function mergeSpans(spans: TextSpan[]): TextSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextSpan[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function parseXmlInner(inner: string): ToolCall | null {
  let toolName: string | undefined;
  for (const re of XML_FUNCTION_NAME_RES) {
    re.lastIndex = 0;
    const m = re.exec(inner);
    if (m?.[1]) {
      toolName = m[1];
      break;
    }
  }

  const args: Record<string, unknown> = {};
  XML_PARAM_RES.lastIndex = 0;
  let param: RegExpExecArray | null;
  while ((param = XML_PARAM_RES.exec(inner)) !== null) {
    const key = param[1];
    const value = (param[2] ?? '').trim();
    if (key) args[key] = value;
  }
  XML_ARG_PAIR_RES.lastIndex = 0;
  while ((param = XML_ARG_PAIR_RES.exec(inner)) !== null) {
    const key = param[1];
    const value = (param[2] ?? '').trim();
    if (key && !(key in args)) args[key] = value;
  }
  BRACKET_PARAM_RE.lastIndex = 0;
  while ((param = BRACKET_PARAM_RE.exec(inner)) !== null) {
    const key = param[1];
    const value = (param[2] ?? '').trim();
    if (key && !(key in args)) args[key] = value;
  }
  if (!toolName && (args.task_id != null || args.action != null)) {
    toolName = 'run_command';
  }
  if (!toolName) return null;
  return newSalvagedCall(toolName, args);
}

function parseXmlToolBlocks(text: string): ParsedEmbeddedToolCalls {
  const calls: ToolCall[] = [];
  const spans: TextSpan[] = [];

  for (const blockRe of XML_BLOCK_RES) {
    blockRe.lastIndex = 0;
    let block: RegExpExecArray | null;
    while ((block = blockRe.exec(text)) !== null) {
      const call = parseXmlInner(block[1] ?? '');
      if (!call) continue;
      calls.push(call);
      spans.push({ start: block.index, end: block.index + block[0].length });
    }
  }

  // 未闭合 XML 尾块（流式截断常见）
  const unclosedRe = /<tool[_-]?call>\s*([\s\S]*)$/i;
  const unclosed = unclosedRe.exec(text);
  if (unclosed?.index != null && unclosed[1]?.trim()) {
    const start = unclosed.index;
    if (!spans.some(s => s.start <= start && s.end > start)) {
      const call = parseXmlInner(unclosed[1]);
      if (call) {
        calls.push(call);
        spans.push({ start, end: text.length });
      }
    }
  }

  return { calls, spans };
}

/** 识别带通道分隔符 / 方括号参数的闭合工具块（不绑定单一厂商）。 */
function parseDelimitedToolInvocationRegions(text: string): ParsedEmbeddedToolCalls {
  const calls: ToolCall[] = [];
  const spans: TextSpan[] = [];

  TOOL_INVOCATION_REGION_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = TOOL_INVOCATION_REGION_RE.exec(text)) !== null) {
    const inner = (block[1] ?? '').replace(CHANNEL_DELIMITER_RE, '');
    const call = parseXmlInner(inner);
    if (!call) continue;
    calls.push(call);
    spans.push({ start: block.index, end: block.index + block[0].length });
  }

  return { calls, spans };
}

/** 无标准 XML 头、仅方括号/通道分隔参数块（常见于流式尾块）。 */
function parseBracketChannelToolFragment(text: string): ParsedEmbeddedToolCalls {
  if (!/\[<[a-zA-Z_][\w.-]*>/i.test(text) && !/<\][a-zA-Z][\w.-]*\[>/i.test(text)) {
    return { calls: [], spans: [] };
  }
  const inner = text.replace(CHANNEL_DELIMITER_RE, '');
  const call = parseXmlInner(inner);
  if (!call) return { calls: [], spans: [] };
  return { calls: [call], spans: [{ start: 0, end: text.length }] };
}

/** 去掉通道分隔符、方括号参数残片、压缩摘要粘连等。 */
export function stripResidualToolChannelMarkup(content: string): string {
  let result = content;
  result = result.replace(COMPACT_TOOL_SUMMARY_RE, '');
  result = result.replace(TOOL_INVOCATION_REGION_RE, '');
  result = result.replace(CHANNEL_DELIMITER_RE, '');
  result = result.replace(/\[<\/?[a-zA-Z_][\w.-]*>[^\]]*\]/g, '');
  result = result.replace(/\[<\/?[a-zA-Z_][\w.-]*>\]/g, '');
  result = result.replace(/^\s*\]+\s*$/g, '');
  result = result.replace(/<tool[_-]?call>[\s\S]*$/i, '');
  result = result.replace(/<invoke\b[\s\S]*$/i, '');
  return result.replace(/\n{2,}/g, '\n').trim();
}

function extractBalancedJson(text: string, openBraceIndex: number): { json: string; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { json: text.slice(openBraceIndex, i + 1), end: i + 1 };
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeArgsField(value: unknown): Record<string, unknown> {
  const rec = asRecord(value);
  if (rec) return rec;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed) ?? { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return {};
}

function toolCallFromJsonObject(obj: Record<string, unknown>): ToolCall | null {
  if (Array.isArray(obj.tool_calls)) {
    const nested = obj.tool_calls
      .map(item => toolCallFromJsonObject(asRecord(item) ?? {}))
      .filter((c): c is ToolCall => c != null);
    return nested[0] ?? null;
  }

  const fnObj = asRecord(obj.function);
  const nameRaw = obj.name ?? obj.tool ?? obj.function_name ?? fnObj?.name;
  if (typeof nameRaw !== 'string' || !nameRaw.trim()) return null;

  const argsRaw = obj.arguments ?? obj.parameters ?? obj.params ?? obj.input ?? fnObj?.arguments ?? fnObj?.parameters;
  return newSalvagedCall(nameRaw.trim(), normalizeArgsField(argsRaw));
}

function parseJsonToolObjects(text: string): ParsedEmbeddedToolCalls {
  const calls: ToolCall[] = [];
  const spans: TextSpan[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const slice = text.slice(i);
    if (!TOOL_JSON_KEY_HINT.test(slice)) continue;

    const extracted = extractBalancedJson(text, i);
    if (!extracted) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted.json);
    } catch {
      continue;
    }

    const rec = asRecord(parsed);
    if (!rec) continue;

    const call = toolCallFromJsonObject(rec);
    if (!call) continue;

    calls.push(call);
    spans.push({ start: i, end: extracted.end });
    i = extracted.end - 1;
  }

  return { calls, spans };
}

function parseFencedJsonBlocks(text: string): ParsedEmbeddedToolCalls {
  const calls: ToolCall[] = [];
  const spans: TextSpan[] = [];

  FENCED_JSON_RE.lastIndex = 0;
  let fence: RegExpExecArray | null;
  while ((fence = FENCED_JSON_RE.exec(text)) !== null) {
    const body = (fence[1] ?? '').trim();
    if (!body) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }

    const rec = asRecord(parsed);
    if (!rec) continue;

    const call = toolCallFromJsonObject(rec);
    if (!call) continue;

    calls.push(call);
    spans.push({ start: fence.index, end: fence.index + fence[0].length });
  }

  return { calls, spans };
}

/** 从正文中解析所有可识别的嵌入工具调用（去重重叠区间）。 */
export function parseEmbeddedToolCallsFromText(text: string): ParsedEmbeddedToolCalls {
  const parsers = [
    parseXmlToolBlocks,
    parseDelimitedToolInvocationRegions,
    parseBracketChannelToolFragment,
    parseJsonToolObjects,
    parseFencedJsonBlocks,
  ];
  const calls: ToolCall[] = [];
  const spans: TextSpan[] = [];

  const overlaps = (a: TextSpan, b: TextSpan): boolean =>
    !(a.end <= b.start || a.start >= b.end);

  for (const parse of parsers) {
    const part = parse(text);
    for (let i = 0; i < part.calls.length; i++) {
      const span = part.spans[i];
      const call = part.calls[i];
      if (!span || !call) continue;
      if (spans.some(existing => overlaps(existing, span))) continue;
      calls.push(call);
      spans.push(span);
    }
  }

  return { calls, spans: mergeSpans(spans) };
}

/** 正文是否含可识别的嵌入工具调用。 */
export function containsEmbeddedToolCalls(content: string | undefined): boolean {
  if (!content?.trim()) return false;
  return parseEmbeddedToolCallsFromText(content).calls.length > 0
    || TOOL_JSON_KEY_HINT.test(content)
    || /<tool[_-]?call>/i.test(content)
    || /<invoke\b/i.test(content)
    || /<\][a-zA-Z][\w.-]*\[>/i.test(content)
    || /\[<[a-zA-Z_][\w.-]*>/i.test(content)
    || COMPACT_TOOL_SUMMARY_RE.test(content);
}

/** 移除正文中所有嵌入工具调用片段。 */
export function stripEmbeddedToolCalls(content: string): string {
  const { spans } = parseEmbeddedToolCallsFromText(content);
  if (spans.length === 0) {
    // 启发式：去掉像 tool JSON 的对象（即使 parse 失败）
    return stripLikelyToolJsonObjects(content).trim();
  }

  let out = '';
  let cursor = 0;
  for (const span of mergeSpans(spans)) {
    out += content.slice(cursor, span.start);
    cursor = span.end;
  }
  out += content.slice(cursor);
  return stripResidualToolChannelMarkup(out);
}

function stripLikelyToolJsonObjects(text: string): string {
  let result = text;
  for (let i = 0; i < result.length; i++) {
    if (result[i] !== '{') continue;
    const slice = result.slice(i);
    if (!TOOL_JSON_KEY_HINT.test(slice)) continue;
    const extracted = extractBalancedJson(result, i);
    if (!extracted) continue;
    result = result.slice(0, i) + result.slice(extracted.end);
    i--;
  }
  return stripResidualToolChannelMarkup(result);
}

/** 写入会话 history 前的 assistant 正文净化。 */
export function prepareAssistantContentForHistory(content: string | undefined): string {
  if (!content) return '';
  return stripEmbeddedToolCalls(stripEmbeddedThinking(content));
}

/** 流式过滤：需识别的开放前缀（小写）。 */
export const EMBEDDED_TOOL_OPEN_MARKERS = [
  '<tool_call>',
  '<tool-call>',
  '<invoke',
  '<]',
  '[<',
  '[调用工具:',
  '{"name"',
  '{"tool"',
  '{"function"',
  '{"tool_calls"',
  '```json',
  '```tool',
] as const;

export function partialEmbeddedToolPrefixSuffix(text: string): string {
  const lower = text.toLowerCase();
  let longestPrefix = '';
  for (const marker of EMBEDDED_TOOL_OPEN_MARKERS) {
    const m = marker.toLowerCase();
    for (let len = m.length - 1; len > 0; len--) {
      const prefix = m.slice(0, len);
      if (lower.endsWith(prefix) && prefix.length > longestPrefix.length) {
        longestPrefix = prefix;
      }
    }
  }
  return longestPrefix ? text.slice(text.length - longestPrefix.length) : '';
}
