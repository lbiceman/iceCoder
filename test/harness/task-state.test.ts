import { describe, expect, it } from 'vitest';

import { looksLikeVerificationCommand, TaskState } from '../../src/harness/task-state.js';

describe('looksLikeVerificationCommand', () => {
  it('recognizes node --check as verification', () => {
    expect(looksLikeVerificationCommand('node --check src/harness/logger.ts')).toBe(true);
    expect(looksLikeVerificationCommand('NODE --check foo.ts')).toBe(true);
  });

  it('still recognizes existing verification commands', () => {
    expect(looksLikeVerificationCommand('npx tsc --noEmit')).toBe(true);
    expect(looksLikeVerificationCommand('npm test')).toBe(true);
    expect(looksLikeVerificationCommand('vitest run')).toBe(true);
  });

  it('does not treat arbitrary node commands as verification', () => {
    expect(looksLikeVerificationCommand('node src/index.js')).toBe(false);
  });
});

describe('TaskState verification via node --check', () => {
  it('marks verification passed after successful node --check', () => {
    const state = new TaskState('edit logger.ts');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/harness/logger.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');

    state.recordToolResult(
      { id: 'r1', name: 'run_command', arguments: { command: 'node --check src/harness/logger.ts' } },
      { success: true, output: '' },
    );

    const snap = state.snapshot();
    expect(snap.phase).toBe('verification');
    expect(snap.verificationStatus).toBe('passed');
    expect(state.shouldBlockFinalForVerification()).toBe(false);
  });
});
