import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import { TaskState } from '../../src/harness/task-state.js';
import {
  buildDiagnosticGateMessage,
  checkDelegatePreflight,
  checkToolPreflight,
  isDistArtifactPath,
  shouldActivateBuildDiagnosticGate,
  shouldClearBuildDiagnosticGate,
  taskMentionsBlockedVerificationPipeline,
} from '../../src/harness/harness-tool-preflight.js';
import { appendVerificationEvidenceToBranchBlock } from '../../src/harness/rebuild-escalation.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('harness-tool-preflight', () => {
  it('blocks read_file on dist when verification failed', () => {
    const taskState = new TaskState('goal');
    taskState.forceVerificationFailed();
    const decision = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'dist/src/scenes/MapSelectScene.js' },
      taskState,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('dist_read');
    expect(isDistArtifactPath('build/out.js')).toBe(true);
  });

  it('blocks build commands under diagnostic gate but allows tsc --noEmit', () => {
    const blocked = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'npm run build 2>&1' },
      buildDiagnosticGateActive: true,
    });
    expect(blocked.blocked).toBe(true);

    const allowed = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'npx tsc --noEmit 2>&1' },
      buildDiagnosticGateActive: true,
    });
    expect(allowed.blocked).toBe(false);
  });

  it('activates diagnostic gate when build command hits branch budget', () => {
    const budget = new BranchBudgetTracker({ commandRetryMax: 2 });
    budget.recordFailedCommandAttempt('npm run build 2>&1');
    budget.recordFailedCommandAttempt('npm run build 2>&1');
    const tc = { name: 'run_command', arguments: { command: 'npm run build 2>&1' } };
    const sig = toolCallSignature(tc);
    expect(shouldActivateBuildDiagnosticGate({
      branchBudget: budget,
      executionFailedSignatures: [],
      policyBlockedSignatures: [sig],
      toolCalls: [tc],
      signatureOf: toolCallSignature,
    })).toBe(true);
    expect(buildDiagnosticGateMessage()).toMatch(/Diagnostic Gate/);
  });

  it('blocks delegate tasks that rerun build under diagnostic gate', () => {
    const blocked = checkDelegatePreflight({
      task: 'Execute npm run build 2>&1 and report stderr',
      buildDiagnosticGateActive: true,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('delegate_build_blocked');
  });

  it('blocks delegate tasks with implicit build intent when regex misses commands', () => {
    expect(taskMentionsBlockedVerificationPipeline('Fix build until it passes')).toBe(true);
    const blocked = checkDelegatePreflight({
      task: 'Please fix the build pipeline until verification passes',
      buildDiagnosticGateActive: true,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('delegate_build_blocked');
  });

  it('allows read-only delegate tasks under diagnostic gate', () => {
    const allowed = checkDelegatePreflight({
      task: 'Read-only inspect src/scenes/MainMenuScene.ts and explain the bug',
      buildDiagnosticGateActive: true,
    });
    expect(allowed.blocked).toBe(false);
  });

  it('blocks delegate tasks with shell blacklist commands', () => {
    const blocked = checkDelegatePreflight({
      task: 'Run rm -rf node_modules and report output',
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('shell_blacklist');
  });

  it('blocks delegate tasks with host-kill shell commands', () => {
    const blocked = checkDelegatePreflight({
      task: 'Execute taskkill /F /IM node.exe to clean up',
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('host_kill');
  });

  it('clears diagnostic gate after successful src edit', () => {
    const tc = { name: 'edit_file', arguments: { path: 'src/scenes/MainMenuScene.ts' } };
    expect(shouldClearBuildDiagnosticGate({
      toolCalls: [tc],
      failedSignatures: [],
      signatureOf: toolCallSignature,
    })).toBe(true);
  });

  it('blocks repeated read_file when target missing on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    const attempts = new Map<string, number>();
    attempts.set('src/scenes/MapSelectScene.ts', 1);

    const blocked = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'src/scenes/MapSelectScene.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
      missingFileAttempts: attempts,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('missing_file_repeat');
    expect(blocked.message).toMatch(/STOP/);
  });

  it('allows first read_file on missing path (executor may ENOENT once)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    const attempts = new Map<string, number>();
    const first = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'src/scenes/MapSelectScene.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
      missingFileAttempts: attempts,
    });
    expect(first.blocked).toBe(false);
  });

  it('blocks patch_file when target missing on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    const attempts = new Map<string, number>();
    const decision = checkToolPreflight({
      toolName: 'patch_file',
      args: { path: 'src/scenes/MapSelectScene.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
      missingFileAttempts: attempts,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('missing_file');
    expect(decision.message).toMatch(/write_file/);
    expect(attempts.get('src/scenes/MapSelectScene.ts')).toBe(1);
  });

  it('allows read_file when file exists on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'ok.ts'), 'export {}');
    const decision = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'src/ok.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
    });
    expect(decision.blocked).toBe(false);
  });

  it('blocks run_command that broad-kills node via script', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts', 'kill-all.cjs'),
      "require('child_process').execSync('taskkill /F /IM node.exe');",
      'utf-8',
    );
    const blocked = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'node scripts/kill-all.cjs 2>&1' },
      workspaceRoot: root,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('host_kill');
    expect(blocked.message).toMatch(/HostGuard/);
  });

  it('blocks write_file embedding taskkill /IM node', () => {
    const blocked = checkToolPreflight({
      toolName: 'write_file',
      args: {
        path: 'scripts/fix.cjs',
        content: "execSync('taskkill /F /IM node.exe');",
      },
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('host_kill');
  });

  it('allows taskkill by PID in run_command', () => {
    const allowed = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'taskkill /F /PID 12345' },
    });
    expect(allowed.blocked).toBe(false);
  });

  it('diagnostic gate block can attach verification digest', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_command', arguments: { command: 'npm test' } }],
      },
      {
        role: 'tool',
        toolCallId: 'tc1',
        content: '工具执行错误: Command failed (exit code: 1)\n\nFAIL test/unit/tasks.test.ts',
      },
    ];
    const gateMsg = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'npm run build 2>&1' },
      buildDiagnosticGateActive: true,
    }).message ?? '';
    const enriched = appendVerificationEvidenceToBranchBlock(gateMsg, messages);
    expect(enriched).toContain('[Verification digest]');
    expect(enriched).toContain('test/unit/tasks.test.ts');
  });
});
