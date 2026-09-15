import { describe, expect, it } from 'vitest';

import { inferIntent, TaskState } from '../../src/harness/task-state.js';
import { LEGACY_TASK_VERIFICATION_KEYS } from '../../src/types/legacy-runtime-schema.js';

describe('inferIntent', () => {
  it('maps natural-language check requests to test intent without framework names', () => {
    expect(inferIntent('跑一下仓库里的检查')).toBe('test');
    expect(inferIntent('run tests before finishing')).toBe('test');
  });

  it('does not treat a manifest filename alone as test intent', () => {
    expect(inferIntent('open Cargo.toml')).not.toBe('test');
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
