import { describe, expect, it } from 'vitest';

import { looksLikeVerificationCommand, TaskState } from '../../src/harness/task-state.js';
import { LEGACY_TASK_VERIFICATION_KEYS } from '../../src/types/legacy-runtime-schema.js';

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

describe('TaskState runtime facts', () => {
  it('records a unit-test command and advances phase without completion state', () => {
    const state = new TaskState('edit logger.ts');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/harness/logger.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'c1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'ok' },
    );

    const snap = state.snapshot();
    expect(snap.phase).toBe('verification');
    expect(snap.commandsRun).toContain('npm test');
    for (const key of LEGACY_TASK_VERIFICATION_KEYS) expect(snap).not.toHaveProperty(key);
  });

  it('node --check remains a regular command fact', () => {
    const state = new TaskState('edit');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'c1', name: 'run_command', arguments: { command: 'node --check src/a.ts' } },
      { success: true, output: '' },
    );
    expect(state.snapshot().phase).toBe('editing');
    expect(state.snapshot().commandsRun).toContain('node --check src/a.ts');
  });

  it('records failed npm test without embedding the result in TaskState', () => {
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
    for (const key of LEGACY_TASK_VERIFICATION_KEYS) expect(snap).not.toHaveProperty(key);
  });

  it('records successful file writes with a path', () => {
    const state = new TaskState('继续');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().filesChanged).toEqual(['src/a.ts']);
    for (const key of LEGACY_TASK_VERIFICATION_KEYS) {
      expect(state.snapshot()).not.toHaveProperty(key);
    }
  });

  it('does not record a changed file when write tool lacks path', () => {
    const state = new TaskState('继续');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: {} },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().filesChanged).toEqual([]);
  });
});
