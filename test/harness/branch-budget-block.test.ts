import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import {
  extractRunCommand,
  extractToolTargetPath,
} from '../../src/harness/branch-budget-tool-path.js';

describe('BranchBudgetTracker - hard block gate', () => {
  it('wouldBlockFileEdit when count reaches fileEditMax', () => {
    const t = new BranchBudgetTracker({ fileEditMax: 3 });
    t.recordFileEdit('src/tasks.ts');
    t.recordFileEdit('src/tasks.ts');
    t.recordFileEdit('src/tasks.ts');
    expect(t.wouldBlockFileEdit('src/tasks.ts')).toBe(true);
    expect(t.wouldBlockFileEdit('src/other.ts')).toBe(false);
  });

  it('checkToolBlock rejects write_file at limit', () => {
    const t = new BranchBudgetTracker({ fileEditMax: 2 });
    t.recordFileEdit('src/a.ts');
    t.recordFileEdit('src/a.ts');
    const block = t.checkToolBlock(
      'write_file',
      { path: 'src/a.ts' },
      extractToolTargetPath,
      extractRunCommand,
    );
    expect(block.blocked).toBe(true);
    expect(block.dimension).toBe('file_edit');
    expect(block.message).toMatch(/Blocked/);
  });

  it('checkToolBlock rejects run_command after failed retries', () => {
    const t = new BranchBudgetTracker({ commandRetryMax: 2 });
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('npm test');
    const block = t.checkToolBlock(
      'run_command',
      { command: 'npm test' },
      extractToolTargetPath,
      extractRunCommand,
    );
    expect(block.blocked).toBe(true);
    expect(block.dimension).toBe('command_retry');
  });

  it('checkToolBlock is no-op when disabled', () => {
    const t = new BranchBudgetTracker({ fileEditMax: 1 });
    t.setEnabled(false);
    t.recordFileEdit('src/a.ts');
    t.recordFileEdit('src/a.ts');
    expect(t.checkToolBlock(
      'edit_file',
      { path: 'src/a.ts' },
      extractToolTargetPath,
      extractRunCommand,
    ).blocked).toBe(false);
  });
});
