/**
 * 嵌入工具调用抢救 — 模型未走 API tool_calls、而在正文输出工具意图时的通用处理。
 *
 * 流程：解析 → 执行（harness 主循环）→ 展示/历史净化 → 兜底恢复。
 */

import type { LLMResponse } from '../llm/types.js';
import {
  containsEmbeddedToolCalls,
  parseEmbeddedToolCallsFromText,
  partialEmbeddedToolPrefixSuffix,
  prepareAssistantContentForHistory,
  stripEmbeddedToolCalls,
} from './text-format-tool-call-parsers.js';
import {
  EmbeddedThinkingStreamFilter,
  ReasoningSystemTagStreamFilter,
  type StreamSplitChunk,
  stripEmbeddedThinking,
  stripSystemTagsFromReasoning,
} from './thinking-content-strip.js';

export {
  containsEmbeddedToolCalls,
  parseEmbeddedToolCallsFromText,
  prepareAssistantContentForHistory,
  stripEmbeddedToolCalls,
};

/** @deprecated 使用 {@link containsEmbeddedToolCalls} */
export const containsTextFormatToolCalls = containsEmbeddedToolCalls;

/** @deprecated 使用 {@link parseEmbeddedToolCallsFromText} */
export function parseTextFormatToolCalls(content: string) {
  return parseEmbeddedToolCallsFromText(content).calls;
}

/** @deprecated 使用 {@link stripEmbeddedToolCalls} */
export const stripTextFormatToolCalls = stripEmbeddedToolCalls;

/**
 * 统一抢救入口：原生 tool_calls 时净化正文；否则从嵌入文本解析 toolCalls。
 * 净化后若仍像工具正文但未解析出调用，由 harness 走 no_tool 恢复（见 handleNoToolCalls）。
 */
export function salvageTextToolCallsInResponse(response: LLMResponse): LLMResponse {
  if (response.toolCalls?.length) {
    return { ...response, content: prepareAssistantContentForHistory(response.content ?? '') };
  }
  const raw = stripEmbeddedThinking(response.content?.trim() ?? '');
  if (!raw || !containsEmbeddedToolCalls(raw)) {
    if (raw !== (response.content?.trim() ?? '')) {
      return { ...response, content: raw };
    }
    return response;
  }

  const { calls } = parseEmbeddedToolCallsFromText(raw);
  if (calls.length === 0) {
    return raw !== (response.content?.trim() ?? '') ? { ...response, content: raw } : response;
  }

  const cleaned = stripEmbeddedToolCalls(raw);
  return {
    ...response,
    toolCalls: calls,
    content: cleaned || '',
    finishReason: 'tool_calls',
  };
}

/** 供 harness 主循环使用：在 {@link salvageTextToolCallsInResponse} 之后再尝试一次嵌入解析。 */
export function resolveSalvagedLlmResponse(raw: LLMResponse): LLMResponse {
  let response = salvageTextToolCallsInResponse(raw);
  if (response.toolCalls?.length) return response;

  const rawText = stripEmbeddedThinking(raw.content?.trim() ?? '');
  if (!rawText || !containsEmbeddedToolCalls(rawText)) return response;

  const { calls } = parseEmbeddedToolCallsFromText(rawText);
  if (calls.length === 0) return response;

  return {
    ...response,
    toolCalls: calls,
    content: prepareAssistantContentForHistory(raw.content ?? ''),
    finishReason: 'tool_calls',
  };
}

/** 用户可见 assistant 正文：去掉思考块、system 标签与嵌入的工具调用片段。 */
export function sanitizeAssistantContentForUser(content: string | undefined): string {
  if (!content) return '';
  const withoutThinking = stripEmbeddedThinking(content);
  const withoutSystem = stripSystemTagsFromReasoning(withoutThinking);
  if (!containsEmbeddedToolCalls(withoutSystem)) return withoutSystem;
  const stripped = stripEmbeddedToolCalls(withoutSystem);
  return stripped || '（模型以文本形式输出了工具调用，已尝试解析并执行；无额外文字说明。）';
}

const XML_TOOL_OPEN = /<tool[_-]?call>|<invoke\b|<\][a-zA-Z]|\[<[a-zA-Z_]/i;

/** 流式侧栏：增量剥离嵌入工具调用，避免泄露给用户。 */
export class TextToolCallStreamFilter {
  private hold = '';

  feed(chunk: string): string {
    if (!chunk) return '';
    this.hold += chunk;
    return this.drainSafe();
  }

  flush(): string {
    const rest = stripEmbeddedToolCalls(this.hold);
    this.hold = '';
    return rest;
  }

  private drainSafe(): string {
    let emit = '';
    while (true) {
      const xmlMatch = XML_TOOL_OPEN.exec(this.hold);
      XML_TOOL_OPEN.lastIndex = 0;
      const jsonStart = this.findLikelyToolJsonStart(this.hold);
      const openIdx = xmlMatch
        ? (jsonStart >= 0 ? Math.min(xmlMatch.index, jsonStart) : xmlMatch.index)
        : jsonStart;

      if (openIdx < 0) {
        const partial = partialEmbeddedToolPrefixSuffix(this.hold);
        emit += this.hold.slice(0, this.hold.length - partial.length);
        this.hold = partial;
        break;
      }

      emit += this.hold.slice(0, openIdx);
      this.hold = this.hold.slice(openIdx);

      if (XML_TOOL_OPEN.test(this.hold)) {
        XML_TOOL_OPEN.lastIndex = 0;
        const closeIdx = this.hold.search(/<\/tool[_-]?call>/i);
        if (closeIdx < 0) break;
        const closeMatch = this.hold.match(/<\/tool[_-]?call>/i);
        this.hold = this.hold.slice(closeIdx + (closeMatch?.[0].length ?? 0));
        continue;
      }

      const extracted = this.extractBalancedJsonFromHold(0);
      if (!extracted) break;
      this.hold = this.hold.slice(extracted.end);
    }
    return emit;
  }

  private findLikelyToolJsonStart(text: string): number {
    const hints = ['{"name"', '{"tool"', '{"function"', '{"tool_calls"'];
    let best = -1;
    for (const hint of hints) {
      const idx = text.indexOf(hint);
      if (idx >= 0 && (best < 0 || idx < best)) best = idx;
    }
    return best;
  }

  private extractBalancedJsonFromHold(start: number): { end: number } | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < this.hold.length; i++) {
      const ch = this.hold[i]!;
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return { end: i + 1 };
      }
    }
    return null;
  }
}

/** 流式用户可见正文：先剥离思考块，再剥离 system 标签与嵌入 tool_call。 */
export class AssistantVisibleStreamFilter {
  private readonly thinking = new EmbeddedThinkingStreamFilter();
  private readonly tools = new TextToolCallStreamFilter();
  private readonly thinkingSanitizer = new ReasoningSystemTagStreamFilter();
  private readonly visibleSanitizer = new ReasoningSystemTagStreamFilter();

  private sanitizeThinking(text: string): string {
    if (!text) return '';
    return this.thinkingSanitizer.feed(text);
  }

  private sanitizeVisible(text: string): string {
    if (!text) return '';
    return this.visibleSanitizer.feed(text);
  }

  feed(chunk: string): StreamSplitChunk {
    if (!chunk) return { visible: '', thinking: '' };
    const afterThinking = this.thinking.feed(chunk);
    const visibleRaw = afterThinking.visible ? this.sanitizeVisible(afterThinking.visible) : '';
    const visible = visibleRaw ? this.tools.feed(visibleRaw) : '';
    return { visible, thinking: this.sanitizeThinking(afterThinking.thinking) };
  }

  flush(): StreamSplitChunk {
    const thinkingTail = this.thinking.flush();
    let visible = '';
    if (thinkingTail.visible) visible += this.sanitizeVisible(thinkingTail.visible);
    visible += this.visibleSanitizer.flush();
    if (visible) visible = this.tools.feed(visible);
    visible += this.tools.flush();
    const thinking = this.sanitizeThinking(thinkingTail.thinking) + this.thinkingSanitizer.flush();
    return { visible, thinking };
  }
}
