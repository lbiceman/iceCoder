import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { resolveShellMandatoryConfirm } from '../../src/harness/harness-permission-runtime.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { isUnderRoot } from '../../src/shared/path-scope.js';
import {
  findOutsideWorkspaceWrites,
  OUTSIDE_WORKSPACE_WRITE_CATEGORY,
  OUTSIDE_WORKSPACE_WRITE_DENIAL_HINT,
} from '../../src/tools/shell-outside-write.js';

const scratchDirs: string[] = [];

function makeWorkspace(): { scratch: string; workspace: string; outside: string } {
  const scratch = mkdtempSync(path.join(os.homedir(), '.ice-sandbox-test-'));
  const workspace = path.join(scratch, 'ws');
  const outside = path.join(scratch, 'out');
  mkdirSync(workspace);
  mkdirSync(outside);
  scratchDirs.push(scratch);
  return { scratch, workspace, outside };
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function envFor(outside: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    USERPROFILE: os.homedir(),
    APPDATA: outside,
  };
}

function finding(command: string, workspace: string, outside: string) {
  return findOutsideWorkspaceWrites(command, {
    cwd: workspace,
    workspaceRoot: workspace,
    env: envFor(outside),
  });
}

function expectOutside(command: string, workspace: string, outside: string): void {
  const result = finding(command, workspace, outside);
  const hit = result.outside.length > 0 || result.unresolved.length > 0;
  expect(hit, JSON.stringify(result)).toBe(true);
}

function expectClean(command: string, workspace: string, outside: string): void {
  const result = finding(command, workspace, outside);
  expect(result, JSON.stringify(result)).toEqual({ outside: [], unresolved: [] });
}

describe('findOutsideWorkspaceWrites', () => {
  it('flags paths written outside the workspace', () => {
    const { workspace, outside } = makeWorkspace();
    const desktop = path.join(os.homedir(), 'Desktop', 'a.txt');
    const driveRoot = path.parse(workspace).root;
    const backup = path.join(driveRoot, 'backup-not-workspace');

    expectOutside('rm -rf ../other', workspace, outside);
    expectOutside('cd .. && rmdir /s /q other', workspace, outside);
    expectOutside('cd %APPDATA% & del x.txt', workspace, outside);
    expectOutside(`del /q ${desktop}`, workspace, outside);
    expectOutside('echo x > %USERPROFILE%\\a.txt', workspace, outside);
    expectOutside(`copy src.txt ${backup}`, workspace, outside);
    expectOutside(
      'powershell -Command "Remove-Item -Recurse -Force ~\\Downloads\\x"',
      workspace,
      outside,
    );
    expectOutside(
      'powershell -Command "Copy-Item a.txt -Destination ..\\x"',
      workspace,
      outside,
    );
    expectOutside('npm i -g typescript', workspace, outside);

    const unresolved = finding('rm -rf $(cat list.txt)', workspace, outside);
    expect(unresolved.unresolved.some((item) => item.includes('$('))).toBe(true);
  });

  it('follows a junction out of the workspace', () => {
    const { workspace, outside } = makeWorkspace();
    symlinkSync(outside, path.join(workspace, 'link'), 'junction');
    const result = finding('rm -rf link\\x', workspace, outside);
    expect(result.outside.length).toBeGreaterThan(0);
    expect(result.outside.every((item) => !isUnderRoot(item, workspace))).toBe(true);
    expect(result.outside.some((item) => isUnderRoot(item, outside) || item === '全局包目录')).toBe(true);
  });

  it('allows writes inside the workspace, temp, and null devices', () => {
    const { workspace, outside } = makeWorkspace();
    mkdirSync(path.join(workspace, 'build'));
    mkdirSync(path.join(workspace, 'src'));

    expectClean('rm -rf dist', workspace, outside);
    expectClean('del /q build\\*.log', workspace, outside);
    expectClean('mkdir src\\new', workspace, outside);
    expectClean(`copy ${path.join(driveTemplate(workspace), 'a.txt')} .`, workspace, outside);
    expectClean('npm test > out.log 2>&1', workspace, outside);
    expectClean('build > nul', workspace, outside);
    expectClean('echo hi > %TEMP%\\x.txt', workspace, outside);
    expectClean('echo "a > C:\\b"', workspace, outside);
    expectClean('npm install', workspace, outside);
  });
});

function driveTemplate(workspace: string): string {
  return path.join(path.parse(workspace).root, 'templates');
}

describe('outside workspace write confirmation', () => {
  it('asks before an outside write and tells the model not to rewrite the command', async () => {
    const { workspace, outside } = makeWorkspace();
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const messages: UnifiedMessage[] = [];
    const outsideFile = path.join(outside, 'a.txt');

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        skipPermissionChecks: false,
        workspaceRoot: workspace,
        lockedWorkspaceRoot: workspace,
        onShellMandatoryConfirm,
        sessionId: 'sess-outside',
      },
      {
        toolCalls: [{
          id: 'tc-out',
          name: 'run_command',
          arguments: { command: `echo x > ${outsideFile}` },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onShellMandatoryConfirm).toHaveBeenCalledTimes(1);
    expect(onShellMandatoryConfirm.mock.calls[0][0].risk.category).toBe(OUTSIDE_WORKSPACE_WRITE_CATEGORY);
    expect(executeTool).not.toHaveBeenCalled();
    expect(messages[0]?.content).toContain(OUTSIDE_WORKSPACE_WRITE_DENIAL_HINT);
  });

  it('does not ask when the workspace is unlocked', async () => {
    const { workspace, outside } = makeWorkspace();
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: workspace,
        onShellMandatoryConfirm,
        sessionId: 'sess-unlocked',
      },
      {
        toolCalls: [{
          id: 'tc-unlocked',
          name: 'run_command',
          arguments: { command: `echo x > ${path.join(outside, 'a.txt')}` },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onShellMandatoryConfirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('skipPermissionChecks runs an outside write without asking', async () => {
    const { workspace, outside } = makeWorkspace();
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => false);

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        skipPermissionChecks: true,
        workspaceRoot: workspace,
        lockedWorkspaceRoot: workspace,
        onShellMandatoryConfirm,
        sessionId: 'sess-skip',
      },
      {
        toolCalls: [{
          id: 'tc-skip',
          name: 'run_command',
          arguments: { command: `echo x > ${path.join(outside, 'a.txt')}` },
        }],
        messages: [],
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onShellMandatoryConfirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('blacklist wins when the same command also writes outside', () => {
    const { workspace, outside } = makeWorkspace();
    const decision = resolveShellMandatoryConfirm({
      id: 'both',
      name: 'run_command',
      arguments: { command: `git reset --hard && echo x > ${path.join(outside, 'a.txt')}` },
    }, {
      sessionId: 'sess-both',
      workspaceRoot: workspace,
      lockedWorkspaceRoot: workspace,
    });

    expect(decision.required).toBe(true);
    expect(decision.request?.risk.category).not.toBe(OUTSIDE_WORKSPACE_WRITE_CATEGORY);
  });
});
