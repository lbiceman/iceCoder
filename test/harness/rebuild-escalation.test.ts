import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import {
  extractRunCommand,
  extractToolTargetPath,
} from '../../src/harness/branch-budget-tool-path.js';
import {
  applyRebuildEscalationBypasses,
  appendVerificationEvidenceToBranchBlock,
  buildRebuildEscalationMessage,
  collectRebuildEscalationContext,
  parseFailingTestPaths,
  shouldTriggerFileCapRebuild,
  shouldTriggerMissingFileBudgetRebuild,
  shouldTriggerAnyFileCapRebuild,
} from '../../src/harness/rebuild-escalation.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('rebuild-escalation', () => {
  it('parseFailingTestPaths extracts vitest FAIL lines', () => {
    const output = [
      'FAIL test/unit/tasks.test.ts > TaskScheduler > spawns tasks',
      'AssertionError: expected 0 to be greater than 1',
    ].join('\n');
    expect(parseFailingTestPaths(output)).toEqual(['test/unit/tasks.test.ts']);
  });

  it('collectRebuildEscalationContext attaches verification digest', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_command', arguments: { command: 'npm test' } }],
      },
      {
        role: 'tool',
        toolCallId: 'tc1',
        content: '工具执行错误: Command failed (exit code: 1)\n\nFAIL test/unit/tasks.test.ts\nAssertionError: expected true to be false',
      },
    ];
    const ctx = collectRebuildEscalationContext(messages, { path: 'src/game/systems/tasks.ts', count: 4 });
    expect(ctx.lastVerificationCommand).toBe('npm test');
    expect(ctx.failingTestPaths).toContain('test/unit/tasks.test.ts');
    expect(ctx.verificationDigest).toMatch(/Verification digest/);
  });

  it('buildRebuildEscalationMessage includes mandatory steps and evidence', () => {
    const msg = buildRebuildEscalationMessage(5, {
      topFile: { path: 'src/game/systems/tasks.ts', count: 4 },
      failingTestPaths: ['test/unit/tasks.test.ts'],
      verificationDigest: '[Verification digest]\nFailed suites / cases:\n- FAIL test/unit/tasks.test.ts',
      lastVerificationCommand: 'npm test',
      recentFailureSnippets: ['工具执行错误: Command failed (exit code: 1)'],
      writeBypassGranted: true,
      commandBypassGranted: true,
    });
    expect(msg).toContain('Mandatory workflow');
    expect(msg).toContain('test/unit/tasks.test.ts');
    expect(msg).toContain('src/game/systems/tasks.ts');
    expect(msg).toContain('Last verification evidence');
    expect(msg).toContain('Platform:');
    expect(msg).toMatch(/Forbidden until step 4/);
  });

  it('buildRebuildEscalationMessage uses file-cap header when triggered by budget', () => {
    const msg = buildRebuildEscalationMessage(2, {
      topFile: { path: 'src/game/systems/tasks.ts', count: 4 },
      failingTestPaths: ['test/unit/tasks.test.ts'],
      verificationDigest: null,
      lastVerificationCommand: 'npm test',
      recentFailureSnippets: [],
      writeBypassGranted: true,
      commandBypassGranted: false,
    }, 'file_cap_verification_failed');
    expect(msg).toMatch(/BranchBudget file cap reached/);
    expect(msg).not.toMatch(/consecutive rounds of tool calls have all failed/);
  });

  it('buildRebuildEscalationMessage uses segment renewal header when triggered by budget segment', () => {
    const msg = buildRebuildEscalationMessage(3, {
      topFile: { path: 'src/game/systems/tasks.ts', count: 4 },
      failingTestPaths: ['test/unit/tasks.test.ts'],
      verificationDigest: null,
      lastVerificationCommand: 'npm test',
      recentFailureSnippets: [],
      writeBypassGranted: false,
      commandBypassGranted: false,
    }, 'segment_renewal_budget');
    expect(msg).toMatch(/Recovery budget segment exhausted \(segment #3\)/);
    expect(msg).toMatch(/Platform continues automatically/);
    expect(msg).not.toMatch(/consecutive rounds of tool calls have all failed/);
  });

  it('appendVerificationEvidenceToBranchBlock attaches build digest and source paths', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc2', name: 'run_command', arguments: { command: 'npm run build 2>&1' } }],
      },
      {
        role: 'tool',
        toolCallId: 'tc2',
        content: '工具执行错误: Command failed (exit code: 1)\n\nsrc/scenes/MapSelectScene.ts(10,1): error TS1005: \'}\' expected.',
      },
    ];
    const enriched = appendVerificationEvidenceToBranchBlock(
      '[BranchBudget / Blocked] 工具未执行：npm run build',
      messages,
    );
    expect(enriched).toContain('[Build digest]');
    expect(enriched).toContain('src/scenes/MapSelectScene.ts');
  });

  it('appendVerificationEvidenceToBranchBlock attaches digest and failing test paths', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_command', arguments: { command: 'npm test' } }],
      },
      {
        role: 'tool',
        toolCallId: 'tc1',
        content: '工具执行错误: Command failed (exit code: 1)\n\nFAIL test/unit/tasks.test.ts > random tasks > scheduler spawns\nAssertionError: expected 1 to be greater than or equal to 2',
      },
    ];
    const enriched = appendVerificationEvidenceToBranchBlock(
      '[BranchBudget / Blocked] 工具未执行：tasks.ts 已编辑 4 次',
      messages,
    );
    expect(enriched).toContain('[BranchBudget / Blocked]');
    expect(enriched).toContain('[Verification digest]');
    expect(enriched).toContain('test/unit/tasks.test.ts');
    expect(enriched).toMatch(/expected 1 to be greater than or equal to 2/);
  });

  it('shouldTriggerFileCapRebuild when file cap hit and verification still failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-rebuild-'));
    const t = new BranchBudgetTracker({ fileEditMax: 3 });
    const path = 'src/game/systems/tasks.ts';
    t.recordFileEdit(path);
    t.recordFileEdit(path);
    t.recordFileEdit(path);

    expect(shouldTriggerFileCapRebuild({
      branchBudget: t,
      verificationStatus: 'failed',
      rebuildEscalationInjected: false,
    })).toBe(true);

    expect(shouldTriggerFileCapRebuild({
      branchBudget: t,
      verificationStatus: 'passed',
      rebuildEscalationInjected: false,
    })).toBe(false);

    expect(shouldTriggerFileCapRebuild({
      branchBudget: t,
      verificationStatus: 'failed',
      rebuildEscalationInjected: true,
    })).toBe(false);

    expect(shouldTriggerMissingFileBudgetRebuild({
      branchBudget: t,
      workspaceRoot: root,
      rebuildEscalationInjected: false,
    })).toBe(true);

    const any = shouldTriggerAnyFileCapRebuild({
      branchBudget: t,
      verificationStatus: 'required',
      workspaceRoot: root,
      rebuildEscalationInjected: false,
    });
    expect(any?.trigger).toBe('missing_file_budget_mismatch');
  });

  it('buildRebuildEscalationMessage for missing file budget mismatch', () => {
    const msg = buildRebuildEscalationMessage(2, {
      topFile: { path: 'src/scenes/MapSelectScene.ts', count: 11 },
      failingTestPaths: [],
      verificationDigest: null,
      lastVerificationCommand: null,
      recentFailureSnippets: [],
      writeBypassGranted: true,
      commandBypassGranted: false,
      fileMissingOnDisk: true,
    }, 'missing_file_budget_mismatch');
    expect(msg).toMatch(/never persisted on disk/);
    expect(msg).toMatch(/write_file.*create/i);
    expect(msg).toMatch(/Do NOT.*read_file.*missing path/i);
  });

  it('applyRebuildEscalationBypasses grants write and command retry', () => {
    const t = new BranchBudgetTracker({ fileEditMax: 2, commandRetryMax: 2 });
    t.recordFileEdit('src/a.ts');
    t.recordFileEdit('src/a.ts');
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('npm test');

    const result = applyRebuildEscalationBypasses(
      t,
      { path: 'src/a.ts', count: 2 },
      'npm test',
    );
    expect(result.writeBypassGranted).toBe(true);
    expect(result.commandBypassGranted).toBe(true);
    expect(t.wouldBlockFileEdit('src/a.ts')).toBe(false);
    expect(t.wouldBlockCommandRetry('npm test')).toBe(false);
  });
});

describe('BranchBudgetTracker - command retry bypass', () => {
  it('grantCommandRetryBypass allows one run_command at limit', () => {
    const t = new BranchBudgetTracker({ commandRetryMax: 2 });
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('npm test');

    t.grantCommandRetryBypass('npm test');
    const allowed = t.checkToolBlock(
      'run_command',
      { command: 'npm test' },
      extractToolTargetPath,
      extractRunCommand,
    );
    expect(allowed.blocked).toBe(false);

    const blocked = t.checkToolBlock(
      'run_command',
      { command: 'npm test' },
      extractToolTargetPath,
      extractRunCommand,
    );
    expect(blocked.blocked).toBe(true);
  });
});
