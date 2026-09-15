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
  it('tracks one monotonic workspace mutation per successful file tool call', () => {
    const state = new TaskState('edit');
    const tools = [
      'write_file',
      'edit_file',
      'append_file',
      'batch_edit_file',
      'patch_file',
    ];

    tools.forEach((name, index) => {
      state.recordToolResult(
        { id: `w${index}`, name, arguments: { path: `src/${index}.ts` } },
        { success: true, output: 'ok' },
      );
      expect(state.snapshot().workspaceMutationVersion).toBe(index + 1);
    });

    expect(state.snapshot().workspaceMutationVersion).toBe(5);
  });

  it('bumps for successful fs delete but never for failed mutations', () => {
    const state = new TaskState('edit');

    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'src/a.ts' } },
      { success: false, output: '', error: 'failed' },
    );
    state.recordToolResult(
      { id: 'd1', name: 'fs_operation', arguments: { operation: 'delete', path: 'src/a.ts' } },
      { success: false, output: '', error: 'failed' },
    );
    expect(state.snapshot().workspaceMutationVersion).toBe(0);

    state.recordToolResult(
      { id: 'd2', name: 'fs_operation', arguments: { operation: 'delete', path: 'src/a.ts' } },
      { success: true, output: 'deleted' },
    );
    expect(state.snapshot().workspaceMutationVersion).toBe(1);
  });

  it('tracks every successful mutating fs operation but not list or failures', () => {
    const state = new TaskState('edit');
    for (const [index, operation] of ['create_dir', 'copy', 'move', 'delete'].entries()) {
      state.recordToolResult(
        {
          id: `fs-${operation}`,
          name: 'fs_operation',
          arguments: { operation, path: `src/${index}`, target: `dst/${index}` },
        },
        { success: true, output: 'ok' },
      );
      expect(state.snapshot().workspaceMutationVersion).toBe(index + 1);
    }

    state.recordToolResult(
      { id: 'fs-list', name: 'fs_operation', arguments: { operation: 'list', path: 'src' } },
      { success: true, output: 'files' },
    );
    state.recordToolResult(
      { id: 'fs-failed', name: 'fs_operation', arguments: { operation: 'copy', path: 'a', target: 'b' } },
      { success: false, output: '', error: 'failed' },
    );
    expect(state.snapshot().workspaceMutationVersion).toBe(4);
  });

  it('tracks successful undo and conservatively stale interactive shell writes', () => {
    const state = new TaskState('edit');

    state.recordToolResult(
      { id: 'undo-list', name: 'undo_edit', arguments: { listHistory: true } },
      { success: true, output: 'history' },
    );
    state.recordToolResult(
      { id: 'shell-start', name: 'interactive_shell', arguments: { action: 'start' } },
      { success: true, output: '{"status":"running"}' },
    );
    expect(state.snapshot().workspaceMutationVersion).toBe(0);

    state.recordToolResult(
      { id: 'undo', name: 'undo_edit', arguments: {} },
      { success: true, output: 'undone' },
    );
    state.recordToolResult(
      {
        id: 'shell-command-start',
        name: 'interactive_shell',
        arguments: { action: 'start', command: 'setup.cmd' },
      },
      { success: true, output: '{"status":"running"}' },
    );
    state.recordToolResult(
      {
        id: 'shell-write',
        name: 'interactive_shell',
        arguments: { action: 'write', task_id: 'pty-1', input: 'yes' },
      },
      { success: true, output: '{"status":"running"}' },
    );
    expect(state.snapshot().workspaceMutationVersion).toBe(3);

    state.recordToolResult(
      { id: 'undo-fail', name: 'undo_edit', arguments: {} },
      { success: false, output: '', error: 'failed' },
    );
    state.recordToolResult(
      {
        id: 'shell-write-fail',
        name: 'interactive_shell',
        arguments: { action: 'write', task_id: 'pty-1', input: 'no' },
      },
      { success: false, output: '', error: 'failed' },
    );
    expect(state.snapshot().workspaceMutationVersion).toBe(3);
  });

  it('records a successful command inventory mutation once for any non-empty path list', () => {
    const state = new TaskState('edit');

    state.recordCommandWorkspaceMutation([]);
    expect(state.snapshot().workspaceMutationVersion).toBe(0);

    state.recordCommandWorkspaceMutation(['src/a.ts', 'src/b.ts', 'src/deleted.ts']);
    expect(state.snapshot().workspaceMutationVersion).toBe(1);
  });

  it('round-trips and safely saturates the workspace mutation version', () => {
    const original = new TaskState('edit');
    original.recordCommandWorkspaceMutation(['src/a.ts']);
    original.recordCommandWorkspaceMutation(['src/b.ts']);

    const restored = new TaskState('other');
    restored.applySnapshot(original.snapshot());
    expect(restored.snapshot().workspaceMutationVersion).toBe(2);

    restored.applySnapshot({
      ...restored.snapshot(),
      workspaceMutationVersion: Number.MAX_SAFE_INTEGER,
    });
    restored.recordCommandWorkspaceMutation(['src/c.ts']);
    expect(restored.snapshot().workspaceMutationVersion).toBe(Number.MAX_SAFE_INTEGER);

    restored.applySnapshot({
      ...restored.snapshot(),
      workspaceMutationVersion: Number.NaN,
    });
    expect(restored.snapshot().workspaceMutationVersion).toBe(0);
  });

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
