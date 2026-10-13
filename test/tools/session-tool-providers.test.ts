import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceToolContext } from '../../src/harness/workspace-run-context.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolExecutor } from '../../src/tools/tool-executor.js';
import type { FileParser } from '../../src/parser/file-parser.js';
import {
  collectSessionProvidedTools,
  registerSessionToolProvider,
} from '../../src/tools/session-tool-providers.js';
import type { RegisteredTool } from '../../src/tools/types.js';

function fakeTool(name: string): RegisteredTool {
  return {
    definition: { name, description: name, parameters: { type: 'object', properties: {}, required: [] } },
    handler: async () => ({ success: true, output: name }),
  };
}

describe('session tool providers', () => {
  let disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers) dispose();
    disposers = [];
    vi.restoreAllMocks();
  });

  it('returns nothing when no provider is registered', async () => {
    expect(await collectSessionProvidedTools({ sessionId: 's1' })).toEqual([]);
  });

  it('passes the session id to providers and merges their tools', async () => {
    const seen: string[] = [];
    disposers.push(registerSessionToolProvider(({ sessionId }) => {
      seen.push(sessionId);
      return [fakeTool('a')];
    }));
    disposers.push(registerSessionToolProvider(async () => [fakeTool('b')]));
    const tools = await collectSessionProvidedTools({ sessionId: 's1' });
    expect(tools.map((t) => t.definition.name)).toEqual(['a', 'b']);
    expect(seen).toEqual(['s1']);
  });

  it('skips a failing provider without dropping the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    disposers.push(registerSessionToolProvider(async () => { throw new Error('store down'); }));
    disposers.push(registerSessionToolProvider(() => [fakeTool('ok')]));
    const tools = await collectSessionProvidedTools({ sessionId: 's1' });
    expect(tools.map((t) => t.definition.name)).toEqual(['ok']);
    expect(warn).toHaveBeenCalled();
  });

  it('merges provided tools into the per-turn workspace registry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-session-tools-'));
    try {
      disposers.push(registerSessionToolProvider(({ sessionId }) => [fakeTool(`provided_${sessionId}`)]));
      const ctx = await resolveWorkspaceToolContext({
        sessionDir: dir,
        sessionId: 'turn1',
        userMessage: 'hi',
        defaultWorkDir: dir,
        defaultToolExecutor: {} as ToolExecutor,
        defaultToolRegistry: new ToolRegistry(),
        fileParser: {} as FileParser,
      });
      expect(ctx.toolDefs.map((d) => d.name)).toContain('provided_turn1');
      expect(ctx.toolDefs.map((d) => d.name)).toContain('run_command');
      const res = await ctx.toolExecutor.executeTool({ id: 'c1', name: 'provided_turn1', arguments: {} });
      expect(res.success).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('stops providing tools after unregister', async () => {
    const dispose = registerSessionToolProvider(() => [fakeTool('a')]);
    dispose();
    expect(await collectSessionProvidedTools({ sessionId: 's1' })).toEqual([]);
  });
});
