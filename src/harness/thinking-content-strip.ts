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
const THINKING_CLOSE_MARKERS = ['</think>', '</thinking>', '</think>'] as const;
const REASONING_CLOSE_MARKERS = ['</reasoning>'] as const;

export type StreamSplitChunk = { visible: string; thinking: string };

const EMPTY_STREAM_SPLIT: StreamSplitChunk = { visible: '', thinking: '' };

function partialEmbeddedCloseSuffix(text: string, mode: 'think' | 'reason'): string {
  const markers = mode === 'think' ? THINKING_CLOSE_MARKERS : REASONING_CLOSE_MARKERS;
  const lower = text.toLowerCase();
  let longest = '';
  for (const marker of markers) {
    const m = marker.toLowerCase();
    for (let len = 1; len <= m.length; len++) {
      const prefix = m.slice(0, len);
      if (lower.endsWith(prefix) && prefix.length > longest.length) {
        longest = text.slice(text.length - len);
      }
    }
  }
  return longest;
}

/** 流式侧：正文与嵌入思考块分流（思考进 reasoning UI，不进用户可见正文）。 */
export class EmbeddedThinkingStreamFilter {
  private hold = '';
  private mode: 'outside' | 'in_think' | 'in_reason' = 'outside';

  feed(chunk: string): StreamSplitChunk {
    if (!chunk) return EMPTY_STREAM_SPLIT;
    this.hold += chunk;
    return this.drainSafe();
  }

  flush(): StreamSplitChunk {
    if (this.mode !== 'outside') {
      const thinking = this.hold;
      this.hold = '';
      this.mode = 'outside';
      return { visible: '', thinking };
    }
    const visible = stripEmbeddedThinking(this.hold);
    this.hold = '';
    return { visible, thinking: '' };
  }

  private drainSafe(): StreamSplitChunk {
    let visible = '';
    let thinking = '';
    while (this.hold.length > 0) {
      if (this.mode === 'outside') {
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
          visible += this.hold.slice(0, this.hold.length - partial.length);
          this.hold = partial;
          break;
        }

        visible += this.hold.slice(0, openIdx);
        const openMatch = kind === 'think'
          ? this.hold.slice(openIdx).match(THINKING_OPEN)
          : this.hold.slice(openIdx).match(REASONING_OPEN);
        const openLen = openMatch?.[0].length ?? 0;
        this.hold = this.hold.slice(openIdx + openLen);
        this.mode = kind === 'think' ? 'in_think' : 'in_reason';
        continue;
      }

      const closeRe = this.mode === 'in_think'
        ? /<\/(?:redacted_)?think(?:ing)?>/i
        : /<\/reasoning>/i;
      const closeMatch = closeRe.exec(this.hold);
      if (!closeMatch || closeMatch.index === undefined) {
        const partial = partialEmbeddedCloseSuffix(
          this.hold,
          this.mode === 'in_think' ? 'think' : 'reason',
        );
        thinking += this.hold.slice(0, this.hold.length - partial.length);
        this.hold = partial;
        break;
      }

      thinking += this.hold.slice(0, closeMatch.index);
      this.hold = this.hold.slice(closeMatch.index + closeMatch[0].length);
      this.mode = 'outside';
    }
    return { visible, thinking };
  }
}
