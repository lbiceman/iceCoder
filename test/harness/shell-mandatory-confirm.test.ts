import { describe, expect, it, vi } from 'vitest';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import {
  extractShellCollabCommandFromToolCall,
  resolveShellMandatoryConfirm,
} from '../../src/harness/harness-permission-runtime.js';

describe('shell mandatory confirm runtime', () => {
  it('extracts shell_exec and interactive_shell start commands', () => {
    expect(extractShellCollabCommandFromToolCall({
      id: '1',
      name: 'shell_exec',
      arguments: { command: 'rm -rf /tmp/x' },
    })).toBe('rm -rf /tmp/x');

    expect(extractShellCollabCommandFromToolCall({
      id: '2',
      name: 'interactive_shell',
      arguments: { action: 'start', command: 'ssh host' },
    })).toBe('ssh host');

    expect(extractShellCollabCommandFromToolCall({
      id: '3',
      name: 'interactive_shell',
      arguments: { action: 'write', input: 'secret' },
    })).toBeNull();

    expect(extractShellCollabCommandFromToolCall({
      id: '4',
      name: 'run_command',
      arguments: { command: 'git reset --hard' },
    })).toBe('git reset --hard');

    expect(extractShellCollabCommandFromToolCall({
      id: '5',
      name: 'run_command',
      arguments: { action: 'check', task_id: 'bg_1', command: 'git reset --hard' },
    })).toBeNull();
  });

  it('T29: mandatory confirm runs even when skipPermissionChecks is true', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        skipPermissionChecks: true,
        shellCollabActive: true,
        onShellMandatoryConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-1',
      },
      {
        toolCalls: [{
          id: 'tc-1',
          name: 'shell_exec',
          arguments: { task_id: 'ish_1', command: 'git reset --hard' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onShellMandatoryConfirm).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(messages[0]?.content).toMatch(/confirmation_timeout|denied/i);
  });

  it('T37: unmatched shell_exec skips normal permission and executes', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onConfirm = vi.fn(async () => false);
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [{ pattern: '*', permission: 'confirm' }],
        shellCollabActive: true,
        onConfirm,
        onShellMandatoryConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-1',
      },
      {
        toolCalls: [{
          id: 'tc-1',
          name: 'shell_exec',
          arguments: { task_id: 'ish_1', command: 'chmod 755 file' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onShellMandatoryConfirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('run_command in normal mode triggers mandatory confirm and bypasses skipPermissionChecks', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => true);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        skipPermissionChecks: true,
        shellCollabActive: false,
        onShellMandatoryConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-1',
      },
      {
        toolCalls: [{
          id: 'tc-1',
          name: 'run_command',
          arguments: { command: 'git reset --hard' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onShellMandatoryConfirm).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('resolveShellMandatoryConfirm hard-blocks rm -rf / before confirm', () => {
    const decision = resolveShellMandatoryConfirm({
      id: 'hb',
      name: 'shell_exec',
      arguments: { command: 'rm -rf /' },
    }, { sessionId: 'sess-1', workspaceRoot: '/tmp/workspace' });

    expect(decision.hardBlocked).toBe(true);
    expect(decision.required).toBe(false);
  });

  it('does not re-prompt a denied session+task+command within one run', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const shellMandatoryConfirmDenials = new Set<string>();
    const deps = {
      toolExecutor: { executeTool } as never,
      loopController: new LoopController({ maxRounds: 3 }),
      permissionRules: [],
      shellCollabActive: true,
      onShellMandatoryConfirm,
      workspaceRoot: '/tmp/workspace',
      sessionId: 'sess-1',
    };
    const logger = { toolCall: () => {}, toolResult: () => {} } as never;

    const firstStats = await executeToolCallsStreaming(deps, {
      toolCalls: [{
        id: 'tc-1',
        name: 'shell_exec',
        arguments: { task_id: 'ish-1', command: 'git reset --hard' },
      }],
      messages: [],
      logger,
      shellMandatoryConfirmDenials,
    });
    const secondMessages: UnifiedMessage[] = [];
    const secondStats = await executeToolCallsStreaming(deps, {
      toolCalls: [{
        id: 'tc-2',
        name: 'shell_exec',
        arguments: { task_id: 'ish-1', command: '  GIT   RESET --hard  ' },
      }],
      messages: secondMessages,
      logger,
      shellMandatoryConfirmDenials,
    });

    expect(onShellMandatoryConfirm).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(firstStats.policyBlockedSignatures).toHaveLength(0);
    expect(secondStats.policyBlockedSignatures).toHaveLength(1);
    expect(secondMessages[0]?.content).toMatch(/already denied/i);

    await executeToolCallsStreaming(deps, {
      toolCalls: [{
        id: 'tc-3',
        name: 'shell_exec',
        arguments: { task_id: 'ish-2', command: 'git reset --hard' },
      }],
      messages: [],
      logger,
      shellMandatoryConfirmDenials,
    });
    expect(onShellMandatoryConfirm).toHaveBeenCalledTimes(2);
  });

  it('run_command skips second destructive confirm after mandatory approval', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onConfirm = vi.fn(async () => false);
    const onShellMandatoryConfirm = vi.fn(async () => true);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [{ pattern: '*', permission: 'confirm' }],
        skipPermissionChecks: false,
        shellCollabActive: false,
        onConfirm,
        onShellMandatoryConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-1',
      },
      {
        toolCalls: [{
          id: 'tc-1',
          name: 'run_command',
          arguments: { command: 'git reset --hard' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onShellMandatoryConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('run_command action:check does not trigger mandatory confirm', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        skipPermissionChecks: true,
        shellCollabActive: false,
        onShellMandatoryConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-1',
      },
      {
        toolCalls: [{
          id: 'tc-1',
          name: 'run_command',
          arguments: { action: 'check', task_id: 'bg_1', command: 'git reset --hard' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onShellMandatoryConfirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('run_command denial dedup uses __run_command__ taskId within one run', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const shellMandatoryConfirmDenials = new Set<string>();
    const deps = {
      toolExecutor: { executeTool } as never,
      loopController: new LoopController({ maxRounds: 3 }),
      permissionRules: [],
      shellCollabActive: false,
      onShellMandatoryConfirm,
      workspaceRoot: '/tmp/workspace',
      sessionId: 'sess-1',
    };
    const logger = { toolCall: () => {}, toolResult: () => {} } as never;

    await executeToolCallsStreaming(deps, {
      toolCalls: [{
        id: 'tc-1',
        name: 'run_command',
        arguments: { command: 'git reset --hard' },
      }],
      messages: [],
      logger,
      shellMandatoryConfirmDenials,
    });
    const secondMessages: UnifiedMessage[] = [];
    const secondStats = await executeToolCallsStreaming(deps, {
      toolCalls: [{
        id: 'tc-2',
        name: 'run_command',
        arguments: { command: '  GIT   RESET --hard  ' },
      }],
      messages: secondMessages,
      logger,
      shellMandatoryConfirmDenials,
    });

    expect(onShellMandatoryConfirm).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(secondStats.policyBlockedSignatures).toHaveLength(1);
    expect(secondMessages[0]?.content).toMatch(/already denied/i);
  });
});
