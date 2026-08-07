import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSessionHarnessToolContext } from '../../src/session/session-tool-policy.js';
import { resolveWorkspaceToolContext } from '../../src/harness/workspace-run-context.js';
import {
  clearShellCollab,
  resetShellCollabStoreForTests,
  setShellCollabActive,
} from '../../src/session/shell-collab-store.js';
import { SHELL_COLLAB_TOOL_NAMES } from '../../src/tools/shell-collab-tools.js';

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

describe('session-tool-policy', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    resetShellCollabStoreForTests();
    vi.clearAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    tempDir = undefined;
  });

  it('loads sidecar and builds an isolated shell-only ToolSystem', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-policy-'));
    const sessionId = 'session-harness';
    await setShellCollabActive(sessionId, true, tempDir);
    resetShellCollabStoreForTests();
    const mcpManager = {
      whenReady: vi.fn(),
      getServerInfos: vi.fn(() => []),
    };

    const ctx = await resolveSessionHarnessToolContext({
      sessionDir: tempDir,
      sessionId,
      userMessage: 'ssh student@exam.example.com',
      defaultWorkDir: '/tmp/default',
      defaultToolExecutor: workspaceCtx.toolExecutor as never,
      defaultToolRegistry: workspaceCtx.toolRegistry as never,
      fileParser: {} as never,
      mcpManager: mcpManager as never,
    });

    expect(ctx.shellCollabActive).toBe(true);
    expect(ctx.toolDefs.map((t) => t.name).sort()).toEqual([...SHELL_COLLAB_TOOL_NAMES].sort());
    expect(ctx.toolDefs.map((t) => t.name)).not.toContain('run_command');
    expect(ctx.toolExecutor).not.toBe(workspaceCtx.toolExecutor);
    expect(ctx.toolRegistry).not.toBe(workspaceCtx.toolRegistry);
    expect(ctx.enableRequestAnalysis).toBe(false);
    expect(ctx.mcpRuntimeContext).toEqual({});
    expect(resolveWorkspaceToolContext).not.toHaveBeenCalled();
    expect(mcpManager.whenReady).not.toHaveBeenCalled();
    expect(mcpManager.getServerInfos).not.toHaveBeenCalled();
  });

  it('uses the existing workspace ToolSystem for ordinary sessions', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-policy-'));

    const ctx = await resolveSessionHarnessToolContext({
      sessionDir: tempDir,
      sessionId: 'plain-session',
      userMessage: 'fix login page',
      defaultWorkDir: '/tmp/default',
      defaultToolExecutor: workspaceCtx.toolExecutor as never,
      defaultToolRegistry: workspaceCtx.toolRegistry as never,
      fileParser: {} as never,
    });

    expect(ctx.shellCollabActive).toBe(false);
    expect(ctx.toolDefs.map((t) => t.name)).toEqual(['run_command']);
    expect(ctx.toolExecutor).toBe(workspaceCtx.toolExecutor);
    expect(ctx.toolRegistry).toBe(workspaceCtx.toolRegistry);
    expect(ctx.enableRequestAnalysis).toBe(true);
    expect(ctx.mcpRuntimeContext).toEqual({});
    expect(resolveWorkspaceToolContext).toHaveBeenCalledOnce();
  });

  it('keeps active and ordinary session ToolSystems isolated', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-policy-'));
    await setShellCollabActive('shell-session', true, tempDir);

    const commonParams = {
      sessionDir: tempDir,
      userMessage: 'continue',
      defaultWorkDir: '/tmp/default',
      defaultToolExecutor: workspaceCtx.toolExecutor as never,
      defaultToolRegistry: workspaceCtx.toolRegistry as never,
      fileParser: {} as never,
    };
    const [shellCtx, ordinaryCtx] = await Promise.all([
      resolveSessionHarnessToolContext({ ...commonParams, sessionId: 'shell-session' }),
      resolveSessionHarnessToolContext({ ...commonParams, sessionId: 'ordinary-session' }),
    ]);

    expect(shellCtx.toolDefs.map((tool) => tool.name).sort())
      .toEqual([...SHELL_COLLAB_TOOL_NAMES].sort());
    expect(ordinaryCtx.toolDefs.map((tool) => tool.name)).toEqual(['run_command']);
    expect(shellCtx.toolRegistry).not.toBe(ordinaryCtx.toolRegistry);
    expect(shellCtx.toolExecutor).not.toBe(ordinaryCtx.toolExecutor);
  });

  it('keeps Shell ToolSystem after a rejected exit and restores only after clear', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-policy-'));
    const sessionId = 'exit-session';
    const params = {
      sessionDir: tempDir,
      sessionId,
      userMessage: 'continue',
      defaultWorkDir: '/tmp/default',
      defaultToolExecutor: workspaceCtx.toolExecutor as never,
      defaultToolRegistry: workspaceCtx.toolRegistry as never,
      fileParser: {} as never,
    };

    await setShellCollabActive(sessionId, true, tempDir);
    const activeCtx = await resolveSessionHarnessToolContext(params);
    await setShellCollabActive(sessionId, false, tempDir);
    const rejectedExitCtx = await resolveSessionHarnessToolContext(params);

    expect(activeCtx.toolDefs.map(tool => tool.name).sort())
      .toEqual([...SHELL_COLLAB_TOOL_NAMES].sort());
    expect(rejectedExitCtx.shellCollabActive).toBe(true);
    expect(rejectedExitCtx.toolDefs.map(tool => tool.name).sort())
      .toEqual([...SHELL_COLLAB_TOOL_NAMES].sort());

    await clearShellCollab(sessionId, tempDir);
    const clearedCtx = await resolveSessionHarnessToolContext(params);
    expect(clearedCtx.shellCollabActive).toBe(false);
    expect(clearedCtx.toolDefs.map(tool => tool.name)).toEqual(['run_command']);
  });
});
