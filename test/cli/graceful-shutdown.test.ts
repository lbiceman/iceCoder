/**
 * graceful-shutdown 测试（P1-15）。
 *
 * 验证 registerGracefulShutdown 返回的 trigger 会按顺序执行全部 cleanups
 * （含 drainMemory 等），供 CLI /quit、rl close 等主动退出路径复用，
 * 而非直接 process.exit 跳过清理。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { registerGracefulShutdown, resetShutdownState } from '../../src/cli/graceful-shutdown.js';

afterEach(() => {
  resetShutdownState();
  vi.restoreAllMocks();
});

describe('registerGracefulShutdown trigger', () => {
  it('runs all cleanups in order before exiting', async () => {
    resetShutdownState();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => { throw new Error('__exit__'); }) as never);

    const order: string[] = [];
    const trigger = registerGracefulShutdown({
      timeout: 2000,
      cleanups: [
        () => { order.push('drainMemory'); },
        async () => { await Promise.resolve(); order.push('backgroundTasks'); },
        () => { order.push('mcp'); },
      ],
    });

    expect(typeof trigger).toBe('function');
    await trigger('test').catch(() => { /* process.exit mock throws */ });

    expect(order).toEqual(['drainMemory', 'backgroundTasks', 'mcp']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('continues remaining cleanups even if one throws', async () => {
    resetShutdownState();
    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => { throw new Error('__exit__'); }) as never);

    const order: string[] = [];
    const trigger = registerGracefulShutdown({
      timeout: 2000,
      cleanups: [
        () => { order.push('one'); },
        () => { throw new Error('boom'); },
        () => { order.push('three'); },
      ],
    });

    await trigger('test').catch(() => {});
    expect(order).toEqual(['one', 'three']);
  });
});
