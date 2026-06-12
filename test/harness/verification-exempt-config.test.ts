import { afterEach, describe, expect, it } from 'vitest';

import { isVerificationExemptPath, writeConfirmationPaths } from '../../src/harness/document-deliverable.js';
import {
  isProjectCustomExemptPath,
  isUnderExemptDirPrefix,
  normalizeVerificationExemptPrefix,
  resetVerificationExemptRuntime,
  setVerificationExemptRuntime,
  toWorkspaceRelativePath,
} from '../../src/harness/verification-exempt-config.js';

afterEach(() => {
  resetVerificationExemptRuntime();
});

describe('verification-exempt-config', () => {
  it('normalizeVerificationExemptPrefix strips slashes and rejects ..', () => {
    expect(normalizeVerificationExemptPrefix('  .scratch/  ')).toBe('.scratch');
    expect(normalizeVerificationExemptPrefix('/tmp/agent/')).toBe('tmp/agent');
    expect(normalizeVerificationExemptPrefix('../evil')).toBeNull();
  });

  it('isUnderExemptDirPrefix matches prefix and children only', () => {
    expect(isUnderExemptDirPrefix('.scratch', '.scratch')).toBe(true);
    expect(isUnderExemptDirPrefix('.scratch/out.md', '.scratch')).toBe(true);
    expect(isUnderExemptDirPrefix('src/.scratch/x', '.scratch')).toBe(false);
  });

  it('toWorkspaceRelativePath strips workspace root', () => {
    const ws = 'E:/proj/game';
    expect(toWorkspaceRelativePath('E:/proj/game/.scratch/a.md', ws)).toBe('.scratch/a.md');
  });

  it('setVerificationExemptRuntime applies workspace-relative custom dirs', () => {
    setVerificationExemptRuntime({
      workspaceRoot: 'E:/proj/game',
      prefixes: ['.scratch', 'tmp/agent'],
    });
    expect(isProjectCustomExemptPath('E:/proj/game/.scratch/draft.md')).toBe(true);
    expect(isProjectCustomExemptPath('E:/proj/game/tmp/agent/log.txt')).toBe(true);
    expect(isProjectCustomExemptPath('E:/proj/game/src/main.ts')).toBe(false);
    expect(isVerificationExemptPath('E:/proj/game/.scratch/draft.md')).toBe(true);
    expect(writeConfirmationPaths([
      'E:/proj/game/src/main.ts',
      'E:/proj/game/.scratch/draft.md',
    ])).toEqual(['E:/proj/game/src/main.ts']);
  });
});
