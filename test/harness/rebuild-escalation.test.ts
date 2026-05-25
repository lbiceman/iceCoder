import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import {
  extractRunCommand,
  extractToolTargetPath,
} from '../../src/harness/branch-budget-tool-path.js';
import {
  applyRebuildEscalationBypasses,
  buildRebuildEscalationMessage,
  collectRebuildEscalationContext,
  parseFailingTestPaths,
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
