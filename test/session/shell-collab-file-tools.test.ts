import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSessionHarnessToolContext } from '../../src/session/session-tool-policy.js';
import { resolveWorkspaceToolContext } from '../../src/harness/workspace-run-context.js';
import {
  resetShellCollabStoreForTests,
  setShellCollabActive,
} from '../../src/session/shell-collab-store.js';

const workspaceCtx = {
  workspace: {
    state: { lockedRoot: '/tmp/ws' },
    detection: { changed: false },
  },
  effectiveWorkspaceRoot: '/tmp/ws',
  toolExecutor: { execute: vi.fn() },
  toolRegistry: { getDefinitions: () => [{ name: 'run_command' }] },
  toolDefs: [{ name: 'run_command' }],
};

vi.mock('../../src/harness/workspace-run-context.js', () => ({
  resolveWorkspaceToolContext: vi.fn(async () => ({ ...workspaceCtx })),
}));

describe('shell-collab file tools execution', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    resetShellCollabStoreForTests();
    vi.clearAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    tempDir = undefined;
  });

  it('read_file and write_file work through the isolated shell ToolSystem', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-file-tools-'));
    const sessionId = 'shell-file-exec';
    await setShellCollabActive(sessionId, true, tempDir);

    const ctx = await resolveSessionHarnessToolContext({
      sessionDir: tempDir,
      sessionId,
      userMessage: 'edit local notes',
      defaultWorkDir: tempDir,
      defaultToolExecutor: workspaceCtx.toolExecutor as never,
      defaultToolRegistry: workspaceCtx.toolRegistry as never,
      fileParser: {} as never,
    });

    const targetPath = 'notes.txt';
    const writeResult = await ctx.toolExecutor.executeTool({
      id: 'write-1',
      name: 'write_file',
      arguments: { path: targetPath, content: 'hello shell file tools' },
    });
    expect(writeResult.success).toBe(true);

    const readResult = await ctx.toolExecutor.executeTool({
      id: 'read-1',
      name: 'read_file',
      arguments: { path: targetPath },
    });
    expect(readResult.success).toBe(true);
    expect(readResult.output).toContain('hello shell file tools');

    const diskContent = await fs.readFile(path.join(tempDir, targetPath), 'utf-8');
    expect(diskContent).toBe('hello shell file tools');
  });
});
