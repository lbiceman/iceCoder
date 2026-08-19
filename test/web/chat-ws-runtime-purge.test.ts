import { describe, expect, it } from 'vitest';
import {
  dropSessionRunLocks,
  purgeSessionMaps,
  sessionAbortControllers,
  sessionProcessing,
} from '../../src/web/chat-ws-runtime.js';

describe('chat-ws-runtime purge 顺序', () => {
  it('purgeSessionMaps 不清 abort 锁，避免先于杀 shell 中断 harness', () => {
    const sid = `purge-maps-${Date.now()}`;
    const ctrl = new AbortController();
    sessionAbortControllers.set(sid, ctrl);
    sessionProcessing.add(sid);

    purgeSessionMaps(sid);

    expect(ctrl.signal.aborted).toBe(false);
    expect(sessionAbortControllers.has(sid)).toBe(true);
    expect(sessionProcessing.has(sid)).toBe(true);

    dropSessionRunLocks(sid);
    expect(ctrl.signal.aborted).toBe(true);
    expect(sessionAbortControllers.has(sid)).toBe(false);
    expect(sessionProcessing.has(sid)).toBe(false);
  });
});
