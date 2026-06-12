import type { StreamCallbackChunk } from '../llm/types.js';
import type { HarnessStepEvent } from './types.js';
import { AssistantVisibleStreamFilter } from './text-tool-call-salvage.js';
import { ReasoningSystemTagStreamFilter } from './thinking-content-strip.js';

/** 将 LLM 流式分片转为 Harness step（正文过滤嵌入 tool/thinking 标签）。 */
export function dispatchStreamChunkToStep(
  chunk: StreamCallbackChunk,
  done: boolean,
  streamFilter: AssistantVisibleStreamFilter,
  round: number,
  onStep?: (event: HarnessStepEvent) => void,
  reasoningSanitizer?: ReasoningSystemTagStreamFilter,
): void {
  if (done || chunk === '' || chunk == null) return;
  if (typeof chunk === 'string') {
    const parts = streamFilter.feed(chunk);
    if (parts.thinking) {
      onStep?.({ type: 'reasoning_stream_delta', iteration: round, delta: parts.thinking });
    }
    if (parts.visible) {
      onStep?.({ type: 'stream_delta', iteration: round, delta: parts.visible });
    }
    return;
  }
  if (chunk.channel === 'reasoning' && chunk.delta) {
    const sanitizer = reasoningSanitizer ?? new ReasoningSystemTagStreamFilter();
    const cleaned = sanitizer.feed(chunk.delta);
    if (cleaned) {
      onStep?.({ type: 'reasoning_stream_delta', iteration: round, delta: cleaned });
    }
  }
}
