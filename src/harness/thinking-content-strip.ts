/**
 * 剥离模型写入 content 的内部思考块（如 mimo 的 redacted_thinking）。
 * 与 API reasoning_content 字段无关；仅处理正文里的 XML/HTML 形态思考标签。
 */

/** 流式过滤需识别的思考块开放前缀（小写比对）。 */
export const EMBEDDED_THINKING_OPEN_MARKERS = [
  '<think>',
  '<thinking>',
  '<reasoning>',
] as const;

const THINKING_BLOCK_RE = /<(?:redacted_)?think(?:ing)?>[\s\S]*?<\/(?:redacted_)?think(?:ing)?>/gi;
const REASONING_BLOCK_RE = /<reasoning>[\s\S]*?<\/reasoning>/gi;
const THINKING_TAIL_RE = /<(?:redacted_)?think(?:ing)?>[\s\S]*$/i;
const REASONING_TAIL_RE = /<reasoning>[\s\S]*$/i;

export function containsEmbeddedThinking(content: string): boolean {
  if (!content) return false;
  THINKING_BLOCK_RE.lastIndex = 0;
  REASONING_BLOCK_RE.lastIndex = 0;
  return THINKING_BLOCK_RE.test(content)
    || REASONING_BLOCK_RE.test(content)
    || THINKING_TAIL_RE.test(content)
    || REASONING_TAIL_RE.test(content);
}

/** 去掉完整与未闭合的思考块，并规整空白。 */
export function stripEmbeddedThinking(content: string): string {
  if (!content) return '';
  let result = content
    .replace(THINKING_BLOCK_RE, '')
    .replace(REASONING_BLOCK_RE, '')
    .replace(THINKING_TAIL_RE, '')
    .replace(REASONING_TAIL_RE, '');
  return result.replace(/^\s*\n+/, '').trimEnd();
}

export function partialEmbeddedThinkingPrefixSuffix(text: string): string {
  const lower = text.toLowerCase();
  let longestPrefix = '';
  for (const marker of EMBEDDED_THINKING_OPEN_MARKERS) {
    const m = marker.toLowerCase();
    for (let len = 1; len <= m.length; len++) {
      const prefix = m.slice(0, len);
      if (lower.endsWith(prefix) && prefix.length > longestPrefix.length) {
        longestPrefix = text.slice(text.length - len);
      }
    }
  }
  return longestPrefix;
}

const THINKING_OPEN = /<(?:redacted_)?think(?:ing)?>/i;
const REASONING_OPEN = /<reasoning>/i;

/** 流式侧：增量剥离嵌入思考块，避免泄露给用户。 */
export class EmbeddedThinkingStreamFilter {
  private hold = '';

  feed(chunk: string): string {
    if (!chunk) return '';
    this.hold += chunk;
    return this.drainSafe();
  }

  flush(): string {
    const rest = stripEmbeddedThinking(this.hold);
    this.hold = '';
    return rest;
  }

  private drainSafe(): string {
    let emit = '';
    while (true) {
      THINKING_OPEN.lastIndex = 0;
      REASONING_OPEN.lastIndex = 0;
      const thinkMatch = THINKING_OPEN.exec(this.hold);
      THINKING_OPEN.lastIndex = 0;
      const reasonMatch = REASONING_OPEN.exec(this.hold);
      const thinkIdx = thinkMatch?.index ?? -1;
      const reasonIdx = reasonMatch?.index ?? -1;
      let openIdx = -1;
      let kind: 'think' | 'reason' | null = null;
      if (thinkIdx >= 0 && (reasonIdx < 0 || thinkIdx <= reasonIdx)) {
        openIdx = thinkIdx;
        kind = 'think';
      } else if (reasonIdx >= 0) {
        openIdx = reasonIdx;
        kind = 'reason';
      }

      if (openIdx < 0) {
        const partial = partialEmbeddedThinkingPrefixSuffix(this.hold);
        emit += this.hold.slice(0, this.hold.length - partial.length);
        this.hold = partial;
        break;
      }

      emit += this.hold.slice(0, openIdx);
      this.hold = this.hold.slice(openIdx);

      if (kind === 'think') {
        const closeIdx = this.hold.search(/<\/(?:redacted_)?think(?:ing)?>/i);
        if (closeIdx < 0) break;
        const closeMatch = this.hold.match(/<\/(?:redacted_)?think(?:ing)?>/i);
        this.hold = this.hold.slice(closeIdx + (closeMatch?.[0].length ?? 0));
        continue;
      }

      const closeIdx = this.hold.search(/<\/reasoning>/i);
      if (closeIdx < 0) break;
      this.hold = this.hold.slice(closeIdx + '</reasoning>'.length);
    }
    return emit;
  }
}
