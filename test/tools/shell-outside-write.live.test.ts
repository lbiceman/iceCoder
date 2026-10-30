import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { createShellTool } from '../../src/tools/builtin/shell-tool.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { OUTSIDE_WORKSPACE_WRITE_DENIAL_HINT } from '../../src/tools/shell-outside-write.js';

const live = it.skipIf(process.platform !== 'win32');

function makeScratch(): { scratch: string; workspace: string; outsideFile: string } {
  const scratch = mkdtempSync(path.join(os.homedir(), '.ice-sandbox-live-'));
  const workspace = path.join(scratch, 'ws');
  mkdirSync(workspace);
  return {
    scratch,
    workspace,
    outsideFile: path.join(scratch, 'outside.txt'),
  };
}

async function runCommand(input: {
  workspace: string;
  command: string;
  skip?: boolean;
  allow?: boolean;
  sessionId: string;
}): Promise<{ confirmCount: number; messages: UnifiedMessage[] }> {
  const registry = new ToolRegistry();
  registry.register(createShellTool(input.workspace, input.sessionId));
  const confirm = vi.fn(async () => input.allow === true);
  const messages: UnifiedMessage[] = [];
  await executeToolCallsStreaming(
    {
      toolExecutor: new ToolExecutor(registry, { toolTimeout: 20_000 }),
      loopController: new LoopController({ maxRounds: 1 }),
      permissionRules: [],
      skipPermissionChecks: input.skip === true,
      workspaceRoot: input.workspace,
      lockedWorkspaceRoot: input.workspace,
      onShellMandatoryConfirm: confirm,
      sessionId: input.sessionId,
    },
    {
      toolCalls: [{
        id: `live-${input.sessionId}`,
        name: 'run_command',
        arguments: { command: input.command, background: false },
      }],
      messages,
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
    },
  );
  return { confirmCount: confirm.mock.calls.length, messages };
}

describe('outside workspace write live', () => {
  live('writes inside the workspace and blocks an outside redirect until allowed', async () => {
    const { scratch, workspace, outsideFile } = makeScratch();
    const insideFile = path.join(workspace, 'inside.txt');
    try {
      const inside = await runCommand({
        workspace,
        command: 'echo live-ok> inside.txt',
        sessionId: 'live-inside',
      });
      expect(inside.confirmCount).toBe(0);
      expect(readFileSync(insideFile, 'utf8')).toContain('live-ok');

      const denied = await runCommand({
        workspace,
        command: 'echo nope> ..\\outside.txt',
        allow: false,
        sessionId: 'live-deny',
      });
      expect(denied.confirmCount).toBe(1);
      expect(existsSync(outsideFile)).toBe(false);
      expect(denied.messages[0]?.content).toContain(OUTSIDE_WORKSPACE_WRITE_DENIAL_HINT);

      const allowed = await runCommand({
        workspace,
        command: 'echo nope> ..\\outside.txt',
        allow: true,
        sessionId: 'live-allow',
      });
      expect(allowed.confirmCount).toBe(1);
      expect(readFileSync(outsideFile, 'utf8')).toContain('nope');
      rmSync(outsideFile, { force: true });

      const skipped = await runCommand({
        workspace,
        command: 'echo skipped> ..\\outside.txt',
        skip: true,
        sessionId: 'live-skip',
      });
      expect(skipped.confirmCount).toBe(0);
      expect(readFileSync(outsideFile, 'utf8')).toContain('skipped');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
