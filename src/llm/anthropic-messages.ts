/**
 * 将统一消息转换为 Anthropic `/v1/messages` 请求体，
 * 以及把非流式 Message 响应转回 LLMResponse 所需字段。
 */

import type {
  ContentBlock,
  LLMOptions,
  LLMResponse,
  ToolCall,
  ToolDefinition,
  UnifiedMessage,
} from './types.js';
import { prepareToolsForChatCompletions } from './tool-offering.js';
import {
  applyReasoningEffortToAnthropicParams,
  parseReasoningEffort,
} from './reasoning-effort.js';
import {
  cleanText,
  resolveContentText,
  safeParseToolArguments,
} from './text-sanitize.js';

const FIXED_ANTHROPIC_PARAM_KEYS = [
  'model',
  'max_tokens',
  'messages',
  'system',
  'tools',
  'stream',
  'thinking',
  'temperature',
  'top_p',
  'stop_sequences',
] as const;

export type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

/** 5 分钟 ephemeral 断点。前缀命中后按缓存价计费。 */
export interface AnthropicCacheControl {
  type: 'ephemeral';
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: AnthropicCacheControl }
  | { type: 'image'; source: AnthropicImageSource; cache_control?: AnthropicCacheControl }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: AnthropicCacheControl }
  | { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: AnthropicCacheControl };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  tools?: AnthropicTool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponseContent {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessageResponse {
  content?: AnthropicResponseContent[];
  stop_reason?: string | null;
  usage?: AnthropicUsage | null;
}

const EPHEMERAL_CACHE: AnthropicCacheControl = { type: 'ephemeral' };

interface TaggedBlock {
  block: AnthropicContentBlock;
  /** 当次请求末尾的易变块，断点打在它前面 */
  ephemeral?: boolean;
}

interface DraftMessage {
  role: 'user' | 'assistant';
  blocks: TaggedBlock[];
}

const DATA_IMAGE_RE =
  /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=\s]+)$/i;

const ANTHROPIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function orderAnthropicRequestParams(params: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const key of FIXED_ANTHROPIC_PARAM_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      ordered[key] = value;
      seen.add(key);
    }
  }

  const extraKeys = Object.keys(params)
    .filter((k) => !seen.has(k))
    .sort((a, b) => a.localeCompare(b));
  for (const key of extraKeys) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      ordered[key] = value;
    }
  }

  return ordered;
}

/** data URL → base64 source；其余按 url source。 */
export function convertImageUrlToAnthropicSource(imageUrl: string): AnthropicImageSource {
  const trimmed = imageUrl.trim();
  const match = DATA_IMAGE_RE.exec(trimmed);
  if (match) {
    let mediaType = match[1]!.toLowerCase();
    if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
    if (!ANTHROPIC_IMAGE_TYPES.has(mediaType)) mediaType = 'image/png';
    return {
      type: 'base64',
      media_type: mediaType,
      data: match[2]!.replace(/\s/g, ''),
    };
  }
  return { type: 'url', url: trimmed };
}

export function convertToolDefinitionsToAnthropic(
  tools: ToolDefinition[] | undefined,
): AnthropicTool[] | undefined {
  const prepared = prepareToolsForChatCompletions(tools);
  if (!prepared?.length) return undefined;
  const converted: AnthropicTool[] = prepared.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: normalizeInputSchema(tool.parameters),
  }));
  const last = converted[converted.length - 1];
  if (last) last.cache_control = EPHEMERAL_CACHE;
  return converted;
}

function normalizeInputSchema(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    if (parameters.type === 'object' || parameters.properties) {
      return {
        ...parameters,
        type: typeof parameters.type === 'string' ? parameters.type : 'object',
      };
    }
  }
  return { type: 'object', properties: {} };
}

/**
 * 从 UnifiedMessage[] 抽出 system，其余转为 Anthropic user/assistant 交替消息。
 */
export function convertUnifiedMessagesToAnthropic(messages: UnifiedMessage[]): {
  system?: AnthropicSystemBlock[];
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const drafts: DraftMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = resolveContentText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    const draft = convertSingleToDraft(msg);
    if (draft) drafts.push(draft);
  }

  const repaired = insertMissingToolResults(dropOrphanToolResults(drafts));
  const merged = mergeConsecutiveDrafts(repaired);
  collapseStableTextBlocks(merged);
  applyConversationCacheBreakpoint(merged);
  const out = merged.map((d) => ({
    role: d.role,
    content: emitBlocks(d.blocks),
  }));

  if (out.length > 0 && out[0]!.role !== 'user') {
    out.unshift({ role: 'user', content: '(conversation continues)' });
  }

  const system = systemParts.length > 0
    ? [{ type: 'text' as const, text: systemParts.join('\n\n'), cache_control: EPHEMERAL_CACHE }]
    : undefined;

  return {
    ...(system ? { system } : {}),
    messages: out,
  };
}

/** 相邻的稳定 text 块合成一块，中间用换行，和以前拼成字符串时的正文一致。不跨易变尾。 */
function collapseStableTextBlocks(drafts: DraftMessage[]): void {
  for (const draft of drafts) {
    const next: TaggedBlock[] = [];
    for (const tagged of draft.blocks) {
      const prev = next[next.length - 1];
      if (
        prev
        && !prev.ephemeral
        && !tagged.ephemeral
        && prev.block.type === 'text'
        && tagged.block.type === 'text'
      ) {
        prev.block = { type: 'text', text: `${prev.block.text}\n${tagged.block.text}` };
        continue;
      }
      next.push({ ...tagged, block: { ...tagged.block } });
    }
    draft.blocks = next;
  }
}

/**
 * 对话侧只留一个断点，打在最后一条稳定块上。
 * 易变尾排在断点之后，不进入缓存前缀。system 与最后一个 tool 另有断点，合计不超过 4 个。
 */
function applyConversationCacheBreakpoint(drafts: DraftMessage[]): void {
  for (let i = drafts.length - 1; i >= 0; i--) {
    const blocks = drafts[i]!.blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const tagged = blocks[j]!;
      if (tagged.ephemeral) continue;
      tagged.block = { ...tagged.block, cache_control: EPHEMERAL_CACHE };
      return;
    }
  }
}

export function buildAnthropicMessagesRequest(
  messages: UnifiedMessage[],
  options: LLMOptions,
  defaults: {
    model: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  },
  stream: boolean,
): AnthropicMessagesRequest {
  const converted = convertUnifiedMessagesToAnthropic(messages);
  if (converted.messages.length === 0) {
    throw new Error('Anthropic messages 请求至少需要一条 user/assistant 消息');
  }

  const maxTokens = options.maxTokens ?? defaults.maxTokens;
  const params: Record<string, unknown> = {
    model: options.model || defaults.model,
    max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? Math.floor(maxTokens) : 16384,
    messages: converted.messages,
    stream,
  };

  if (converted.system) params.system = converted.system;

  const temperature = options.temperature ?? defaults.temperature;
  if (temperature !== undefined) params.temperature = temperature;

  const topP = options.topP ?? defaults.topP;
  if (topP !== undefined) params.top_p = topP;

  const tools = convertToolDefinitionsToAnthropic(options.tools);
  if (tools?.length) params.tools = tools;

  applyReasoningEffortToAnthropicParams(params, parseReasoningEffort(options.reasoningEffort));

  return orderAnthropicRequestParams(params) as AnthropicMessagesRequest;
}

export function mapAnthropicStopReason(
  reason: string | null | undefined,
): LLMResponse['finishReason'] {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'error';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    default:
      return 'stop';
  }
}

export function usageFromAnthropic(usage: AnthropicUsage | null | undefined, provider: string): LLMResponse['usage'] {
  const uncached = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const inputTokens = uncached + cacheRead + cacheCreation;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    provider,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
    ...(cacheRead > 0 || cacheCreation > 0 ? { cacheMissTokens: uncached } : {}),
  };
}

export function convertAnthropicMessageResponse(
  response: AnthropicMessageResponse,
  provider: string,
): Pick<LLMResponse, 'content' | 'reasoningContent' | 'toolCalls' | 'finishReason' | 'usage'> {
  const texts: string[] = [];
  const thinking: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of response.content ?? []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (
      block.type === 'thinking'
      || block.type === 'redacted_thinking'
      || block.type === 'reasoning'
    ) {
      const piece = typeof block.thinking === 'string' && block.thinking
        ? block.thinking
        : (typeof block.text === 'string' ? block.text : '');
      if (piece) thinking.push(piece);
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: asArgumentRecord(block.input),
      });
    }
  }

  return {
    content: texts.join(''),
    reasoningContent: thinking.length > 0 ? thinking.join('') : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: mapAnthropicStopReason(response.stop_reason),
    usage: usageFromAnthropic(response.usage, provider),
  };
}

function asArgumentRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    return safeParseToolArguments(input);
  }
  return {};
}

function tagBlocks(blocks: AnthropicContentBlock[], ephemeral: boolean): TaggedBlock[] {
  return blocks.map((block) => (ephemeral ? { block, ephemeral: true } : { block }));
}

function convertSingleToDraft(msg: UnifiedMessage): DraftMessage | null {
  const ephemeral = msg.promptCacheEphemeral === true;
  switch (msg.role) {
    case 'user':
      return { role: 'user', blocks: tagBlocks(convertUserContent(msg.content), ephemeral) };
    case 'assistant':
      return { role: 'assistant', blocks: tagBlocks(convertAssistantContent(msg), ephemeral) };
    case 'tool':
      return {
        role: 'user',
        blocks: tagBlocks([{
          type: 'tool_result',
          tool_use_id: msg.toolCallId || '',
          content: resolveContentText(msg.content) || '[工具结果丢失]',
        }], ephemeral),
      };
    default:
      return { role: 'user', blocks: tagBlocks(convertUserContent(msg.content), ephemeral) };
  }
}

function convertUserContent(content: string | ContentBlock[]): AnthropicContentBlock[] {
  if (!Array.isArray(content)) {
    const text = resolveContentText(content);
    return text ? [{ type: 'text', text }] : [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      const text = cleanText(block.text);
      if (text) blocks.push({ type: 'text', text });
    } else if (block.type === 'image' && block.imageUrl) {
      blocks.push({
        type: 'image',
        source: convertImageUrlToAnthropicSource(block.imageUrl),
      });
    }
  }
  return blocks;
}

function convertAssistantContent(msg: UnifiedMessage): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  const text = resolveContentText(msg.content);
  if (text) blocks.push({ type: 'text', text });
  if (msg.toolCalls?.length) {
    for (const tc of msg.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {},
      });
    }
  }
  return blocks;
}

function dropOrphanToolResults(drafts: DraftMessage[]): DraftMessage[] {
  const required = new Set<string>();
  for (const draft of drafts) {
    if (draft.role !== 'assistant') continue;
    for (const tagged of draft.blocks) {
      const block = tagged.block;
      if (block.type === 'tool_use' && block.id) required.add(block.id);
    }
  }

  const out: DraftMessage[] = [];
  for (const draft of drafts) {
    if (draft.role !== 'user') {
      out.push(draft);
      continue;
    }
    const blocks = draft.blocks.filter((tagged) => {
      if (tagged.block.type !== 'tool_result') return true;
      return !!tagged.block.tool_use_id && required.has(tagged.block.tool_use_id);
    });
    if (blocks.length > 0 || draft.blocks.length === 0) {
      out.push({ role: 'user', blocks });
    }
  }
  return out;
}

function insertMissingToolResults(drafts: DraftMessage[]): DraftMessage[] {
  const existing = new Set<string>();
  for (const draft of drafts) {
    for (const tagged of draft.blocks) {
      const block = tagged.block;
      if (block.type === 'tool_result' && block.tool_use_id) {
        existing.add(block.tool_use_id);
      }
    }
  }

  const out: DraftMessage[] = [];
  for (const draft of drafts) {
    out.push(draft);
    if (draft.role !== 'assistant') continue;
    const missing: TaggedBlock[] = [];
    for (const tagged of draft.blocks) {
      const block = tagged.block;
      if (block.type === 'tool_use' && block.id && !existing.has(block.id)) {
        missing.push({
          block: {
            type: 'tool_result',
            tool_use_id: block.id,
            content: '[工具结果丢失]',
          },
        });
        existing.add(block.id);
      }
    }
    if (missing.length > 0) {
      out.push({ role: 'user', blocks: missing });
    }
  }
  return out;
}

function mergeConsecutiveDrafts(drafts: DraftMessage[]): DraftMessage[] {
  const merged: DraftMessage[] = [];
  for (const draft of drafts) {
    if (draft.blocks.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === draft.role) {
      last.blocks.push(...draft.blocks);
    } else {
      merged.push({ role: draft.role, blocks: [...draft.blocks] });
    }
  }
  return merged;
}

function emitBlocks(tagged: TaggedBlock[]): string | AnthropicContentBlock[] {
  const blocks = tagged.map((item) => item.block);
  if (blocks.length === 0) return '';
  // 始终用 block。断点移走时如果退回纯字符串，前缀字节会变，缓存每轮失效。
  return blocks;
}
