import { describe, expect, it, vi } from 'vitest';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('Shell collaboration file tool permission', () => {
  it('requires onConfirm for fs_operation delete in shell mode even when skipPermissionChecks is true', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'deleted' }));
    const onConfirm = vi.fn(async () => false);
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [{ pattern: 'fs_operation', permission: 'confirm' }],
        skipPermissionChecks: true,
        shellCollabActive: true,
        onConfirm,
        onShellMandatoryConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-shell-file',
      },
      {
        toolCalls: [{
          id: 'tc-delete',
          name: 'fs_operation',
          arguments: { operation: 'delete', path: 'tmp/old.log' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onShellMandatoryConfirm).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(messages[0]?.content).toMatch(/denied tool fs_operation/i);
  });

  it('executes fs_operation delete in shell mode after onConfirm approval', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'File deleted: tmp/old.log' }));
    const onConfirm = vi.fn(async () => true);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [{ pattern: 'fs_operation', permission: 'confirm' }],
        skipPermissionChecks: true,
        shellCollabActive: true,
        onConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-shell-file-ok',
      },
      {
        toolCalls: [{
          id: 'tc-delete-ok',
          name: 'fs_operation',
          arguments: { operation: 'delete', path: 'tmp/old.log' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('skips fs_operation confirm outside shell mode when skipPermissionChecks is true', async () => {
    const executeTool = vi.fn(async () => ({ success: true, output: 'deleted' }));
    const onConfirm = vi.fn(async () => false);
    const messages: UnifiedMessage[] = [];

    await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [{ pattern: 'fs_operation', permission: 'confirm' }],
        skipPermissionChecks: true,
        shellCollabActive: false,
        onConfirm,
        workspaceRoot: '/tmp/workspace',
        sessionId: 'sess-normal',
      },
      {
        toolCalls: [{
          id: 'tc-delete-normal',
          name: 'fs_operation',
          arguments: { operation: 'delete', path: 'tmp/old.log' },
        }],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(onConfirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
