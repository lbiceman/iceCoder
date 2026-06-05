import type { StreamCallbackChunk } from '../llm/types.js';
import type { HarnessStepEvent } from './types.js';
import { AssistantVisibleStreamFilter } from './text-tool-call-salvage.js';

/** 将 LLM 流式分片转为 Harness step（正文过滤嵌入 tool/thinking 标签）。 */
export function dispatchStreamChunkToStep(
  chunk: StreamCallbackChunk,
  done: boolean,
  streamFilter: AssistantVisibleStreamFilter,
  round: number,
  onStep?: (event: HarnessStepEvent) => void,
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
    onStep?.({ type: 'reasoning_stream_delta', iteration: round, delta: chunk.delta });
  }
}
