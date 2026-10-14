/**
 * 记忆精排让路、断线补发。不打外部 API。
 * 工具轮之后仍用关键词；只有话题切换或明确在问约定时才精排，并且超时后放行。
 * 连接没打开时用户消息入队，其它消息丢掉，关连接不清本地「正在跑」。
 */
import { describe, expect, it } from 'vitest';

import { hasTopicShifted, raceMemorySideQuery } from '../../src/harness/harness-memory.js';
import {
  asksAboutRememberedContext,
  resolveRecallInjectMode,
} from '../../src/harness/harness-round-prep.js';
import {
  enqueueOutboundMessage,
  flushOutboundMessages,
  planSocketSend,
  shouldResetProcessingOnSocketClose,
  WS_OUTBOUND_QUEUE_LIMIT,
} from '../../src/web/ws-outbound-queue.js';

describe('eval: recall yield and reconnect queue', () => {
  it('keeps keyword recall after tools unless the user changes topic or asks what was remembered', () => {
    expect(resolveRecallInjectMode({
      casual: false,
      hadToolRoundThisRun: true,
    })).toBe('coarse_pre_llm');
    expect(asksAboutRememberedContext('继续修这个 bug')).toBe(false);
    expect(asksAboutRememberedContext('上次测试失败了，帮我看一下')).toBe(false);
    expect(asksAboutRememberedContext('你记得我上次怎么配置的吗')).toBe(true);
    expect(resolveRecallInjectMode({
      casual: false,
      hadToolRoundThisRun: true,
      asksMemory: true,
    })).toBe('default');
    expect(hasTopicShifted(
      '给登录页补一个空状态',
      '把发布脚本改成只打 linux 包',
    )).toBe(true);
    expect(resolveRecallInjectMode({
      casual: false,
      hadToolRoundThisRun: true,
      topicShifted: true,
    })).toBe('default');
  });

  it('returns the keyword fallback when a side query does not finish in time', async () => {
    const started = Date.now();
    let sawAbort = false;
    const result = await raceMemorySideQuery((signal) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      return new Promise<string>(() => {});
    }, 'keyword', 40);
    expect(result).toBe('keyword');
    expect(sawAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('queues unsent chat messages in order and keeps the processing flag across a dropped socket', () => {
    expect(planSocketSend(true, 'message')).toBe('send');
    expect(planSocketSend(false, 'message')).toBe('queue');
    expect(planSocketSend(false, 'stop')).toBe('drop');
    expect(shouldResetProcessingOnSocketClose()).toBe(false);

    let queue = enqueueOutboundMessage([], { type: 'message', messageId: 'a', content: 'one' });
    queue = enqueueOutboundMessage(queue, { type: 'message', messageId: 'b', content: 'two' });
    const flushed = flushOutboundMessages(queue);
    expect(flushed.rest).toEqual([]);
    expect(flushed.pending.map((item) => item.messageId)).toEqual(['a', 'b']);

    let capped: Array<{ messageId: string }> = [];
    for (let i = 0; i < WS_OUTBOUND_QUEUE_LIMIT + 3; i++) {
      capped = enqueueOutboundMessage(capped, { messageId: String(i) });
    }
    expect(capped).toHaveLength(WS_OUTBOUND_QUEUE_LIMIT);
    expect(capped[0]?.messageId).toBe('3');
    expect(capped.at(-1)?.messageId).toBe(String(WS_OUTBOUND_QUEUE_LIMIT + 2));
  });
});
