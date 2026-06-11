import { describe, expect, it, vi } from 'vitest';
import { AssistantVisibleStreamFilter } from '../../src/harness/text-tool-call-salvage.js';
import { dispatchStreamChunkToStep } from '../../src/harness/stream-step-dispatch.js';
import { ReasoningSystemTagStreamFilter } from '../../src/harness/thinking-content-strip.js';
import type { HarnessStepEvent } from '../../src/harness/types.js';

describe('stream-step-dispatch (no-thinking models)', () => {
  it('plain content only emits stream_delta, never reasoning_stream_delta', () => {
    const filter = new AssistantVisibleStreamFilter();
    const steps: HarnessStepEvent[] = [];
    const onStep = (e: HarnessStepEvent) => steps.push(e);

    dispatchStreamChunkToStep('Hello from GPT-4o', false, filter, 1, onStep);
    dispatchStreamChunkToStep('', false, filter, 1, onStep);
    dispatchStreamChunkToStep(null as unknown as string, false, filter, 1, onStep);

    expect(steps.map((s) => s.type)).toEqual(['stream_delta']);
    expect(steps[0]?.delta).toBe('Hello from GPT-4o');
    expect(steps.some((s) => s.type === 'reasoning_stream_delta')).toBe(false);
  });

  it('done or empty chunk is a no-op', () => {
    const filter = new AssistantVisibleStreamFilter();
    const onStep = vi.fn();

    dispatchStreamChunkToStep('partial', true, filter, 1, onStep);
    dispatchStreamChunkToStep('', false, filter, 1, onStep);

    expect(onStep).not.toHaveBeenCalled();
  });

  it('reasoning channel only fires when adapter provides reasoning delta', () => {
    const filter = new AssistantVisibleStreamFilter();
    const sanitizer = new ReasoningSystemTagStreamFilter();
    const steps: HarnessStepEvent[] = [];

    dispatchStreamChunkToStep(
      { channel: 'reasoning', delta: 'chain of thought' },
      false,
      filter,
      2,
      (e) => steps.push(e),
      sanitizer,
    );

    expect(steps).toEqual([
      { type: 'reasoning_stream_delta', iteration: 2, delta: 'chain of thought' },
    ]);
  });

  it('reasoning channel strips leaked system tags', () => {
    const filter = new AssistantVisibleStreamFilter();
    const sanitizer = new ReasoningSystemTagStreamFilter();
    const steps: HarnessStepEvent[] = [];

    dispatchStreamChunkToStep(
      { channel: 'reasoning', delta: '分析<system>\n</system>继续' },
      false,
      filter,
      2,
      (e) => steps.push(e),
      sanitizer,
    );

    expect(steps[0]?.delta).toBe('分析继续');
  });

  it('flush with no embedded thinking yields no reasoning tail', () => {
    const filter = new AssistantVisibleStreamFilter();
    const streamed = filter.feed('Final answer only.');
    const tail = filter.flush();
    expect(streamed.thinking).toBe('');
    expect(streamed.visible).toBe('Final answer only.');
    expect(tail.thinking).toBe('');
    expect(tail.visible).toBe('');
  });
});
