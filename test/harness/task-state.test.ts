import { describe, expect, it } from 'vitest';

import { looksLikeVerificationCommand, TaskState } from '../../src/harness/task-state.js';

describe('looksLikeVerificationCommand', () => {
  it('recognizes unit test commands only', () => {
    expect(looksLikeVerificationCommand('npm test')).toBe(true);
    expect(looksLikeVerificationCommand('vitest run')).toBe(true);
    expect(looksLikeVerificationCommand('mvn test')).toBe(true);
  });

  it('does not treat lint/build/tsc/node --check as unit test verification', () => {
    expect(looksLikeVerificationCommand('node --check src/harness/logger.ts')).toBe(false);
    expect(looksLikeVerificationCommand('npx tsc --noEmit')).toBe(false);
    expect(looksLikeVerificationCommand('npm run lint')).toBe(false);
    expect(looksLikeVerificationCommand('npm run build')).toBe(false);
  });

  it('does not treat arbitrary node commands as verification', () => {
    expect(looksLikeVerificationCommand('node src/index.js')).toBe(false);
  });
});

describe('TaskState unit test verification', () => {
  it('marks verification passed after successful npm test', () => {
    const state = new TaskState('edit logger.ts');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/harness/logger.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');

    state.recordToolResult(
      { id: 'c1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'ok' },
    );

    const snap = state.snapshot();
    expect(snap.phase).toBe('verification');
    expect(snap.verificationStatus).toBe('passed');
    expect(state.isVerificationBlockingFinalAfterSync()).toBe(false);
  });

  it('node --check success leaves verification required', () => {
    const state = new TaskState('edit');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'c1', name: 'run_command', arguments: { command: 'node --check src/a.ts' } },
      { success: true, output: '' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('records failed npm test but does not block gate', () => {
    const state = new TaskState('implement game');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'src/game/x.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: '', error: 'exit 1' },
    );

    const snap = state.snapshot();
    expect(snap.commandsRun).toContain('npm test');
    expect(snap.verificationStatus).toBe('failed');
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('sets verification required on successful file write with path', () => {
    const state = new TaskState('继续');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationRequired).toBe(true);
    expect(state.snapshot().verificationStatus).toBe('required');
  });

  it('does not set verification required when write tool lacks path', () => {
    const state = new TaskState('继续');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: {} },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().filesChanged).toEqual([]);
    expect(state.snapshot().verificationStatus).toBe('not_required');
  });
});
