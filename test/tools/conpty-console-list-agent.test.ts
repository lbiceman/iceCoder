import { describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import { disableConptyConsoleListAgent } from '../../src/tools/interactive-shell-manager.js';

function fakePty(agent?: Record<string, unknown>): IPty {
  return { _agent: agent } as unknown as IPty;
}

describe('disableConptyConsoleListAgent', () => {
  it('replaces the console list fork with an empty list on win32', async () => {
    const original = () => Promise.resolve([123]);
    const agent: Record<string, unknown> = { _getConsoleProcessList: original };
    expect(disableConptyConsoleListAgent(fakePty(agent), 'win32')).toBe(true);
    expect(agent._getConsoleProcessList).not.toBe(original);
    await expect((agent._getConsoleProcessList as () => Promise<number[]>)()).resolves.toEqual([]);
  });

  it('leaves non-Windows ptys untouched', () => {
    const original = () => Promise.resolve([123]);
    const agent: Record<string, unknown> = { _getConsoleProcessList: original };
    expect(disableConptyConsoleListAgent(fakePty(agent), 'linux')).toBe(false);
    expect(agent._getConsoleProcessList).toBe(original);
  });

  it('is a no-op when node-pty internals change', () => {
    expect(disableConptyConsoleListAgent(fakePty(undefined), 'win32')).toBe(false);
    expect(disableConptyConsoleListAgent(fakePty({}), 'win32')).toBe(false);
  });
});
