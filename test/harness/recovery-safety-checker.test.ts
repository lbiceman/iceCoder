import { describe, expect, it } from 'vitest';

import { RecoverySafetyChecker } from '../../src/harness/supervisor/recovery-safety-checker.js';
import type { WorkspaceSnapshot } from '../../src/types/supervisor.js';

function makeSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    snapshotId: 'safety-test',
    at: 0,
    gitSummary: 'clean',
    filesAdded: [],
    filesModified: [],
    filesDeleted: [],
    ...overrides,
  };
}

describe('RecoverySafetyChecker', () => {
  it('returns recoverable=true with empty reasons for a clean snapshot', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({ snapshot: makeSnapshot() });
    expect(result).toEqual({
      recoverable: true,
      reasons: [],
      missingFiles: [],
      humanReason: 'ok',
    });
  });

  it('flags critical_file_missing when required files are absent', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({
      snapshot: makeSnapshot(),
      criticalFiles: ['src/index.ts', 'package.json', 'README.md'],
      existingFiles: ['src/index.ts', 'package.json'],
    });
    expect(result.recoverable).toBe(false);
    expect(result.reasons).toContain('critical_file_missing');
    expect(result.missingFiles).toEqual(['README.md']);
    expect(result.humanReason).toContain('critical_file_missing:README.md');
  });

  it('does not report missing files when existingFiles is omitted', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({
      snapshot: makeSnapshot(),
      criticalFiles: ['package.json'],
    });
    expect(result.recoverable).toBe(true);
  });

  it('marks repo_unhealthy when gitSummary contains conflict marker', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({
      snapshot: makeSnapshot({ gitSummary: 'conflict during merge' }),
    });
    expect(result.recoverable).toBe(false);
    expect(result.reasons).toContain('repo_unhealthy');
  });

  it('honors explicit repoHealthy=false overriding gitSummary heuristic', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({
      snapshot: makeSnapshot({ gitSummary: 'clean' }),
      repoHealthy: false,
    });
    expect(result.reasons).toContain('repo_unhealthy');
  });

  it('marks branch_unhealthy when caller injects branchHealthy=false', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({
      snapshot: makeSnapshot(),
      branchHealthy: false,
    });
    expect(result.reasons).toContain('branch_unhealthy');
  });

  it('detects baseline_broken from fatal markers in buildSummary', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({
      snapshot: makeSnapshot({ buildSummary: 'tsc panic: stack overflow' }),
    });
    expect(result.reasons).toContain('baseline_broken');
  });

  it('truncates missing files in humanReason when more than three', () => {
    const checker = new RecoverySafetyChecker();
    const result = checker.check({
      snapshot: makeSnapshot(),
      criticalFiles: ['a', 'b', 'c', 'd', 'e'],
      existingFiles: [],
    });
    expect(result.humanReason).toContain('+2');
  });
});
