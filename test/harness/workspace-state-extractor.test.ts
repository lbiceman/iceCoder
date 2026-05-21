import { describe, expect, it } from 'vitest';

import { WorkspaceStateExtractor } from '../../src/harness/supervisor/workspace-state-extractor.js';
import type {
  RepoContextSnapshot,
  TaskStateSnapshot,
} from '../../src/types/runtime-snapshot.js';

function makeTask(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    goal: 'fix login bug',
    intent: 'debug',
    phase: 'editing',
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    verificationRequired: false,
    verificationStatus: 'not_required',
    ...overrides,
  };
}

function makeRepo(overrides: Partial<RepoContextSnapshot> = {}): RepoContextSnapshot {
  return {
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    testCommands: [],
    recentDiagnostics: [],
    ...overrides,
  };
}

describe('WorkspaceStateExtractor', () => {
  it('returns gitSummary=clean when repo has no changes', () => {
    const extractor = new WorkspaceStateExtractor();
    const snapshot = extractor.extract({
      task: makeTask(),
      repo: makeRepo(),
      now: () => 1000,
      snapshotId: 'snap-fixed',
    });

    expect(snapshot).toMatchObject({
      snapshotId: 'snap-fixed',
      at: 1000,
      gitSummary: 'clean',
      filesAdded: [],
      filesModified: [],
      filesDeleted: [],
    });
  });

  it('classifies changed files using preExistingFiles set', () => {
    const extractor = new WorkspaceStateExtractor();
    const snapshot = extractor.extract({
      task: makeTask({ filesChanged: ['src/a.ts', 'src/new.ts'] }),
      repo: makeRepo({ filesChanged: ['src/a.ts', 'src/new.ts'] }),
      preExistingFiles: ['src/a.ts'],
      snapshotId: 'snap-1',
    });

    expect(snapshot.filesAdded).toEqual(['src/new.ts']);
    expect(snapshot.filesModified).toEqual(['src/a.ts']);
    expect(snapshot.gitSummary).toBe('M:2');
  });

  it('falls back to repo.filesRead when preExistingFiles is omitted', () => {
    const extractor = new WorkspaceStateExtractor();
    const snapshot = extractor.extract({
      task: makeTask({ filesRead: ['src/a.ts'], filesChanged: ['src/a.ts'] }),
      repo: makeRepo({ filesChanged: ['src/a.ts'] }),
      snapshotId: 'snap-2',
    });

    expect(snapshot.filesModified).toEqual(['src/a.ts']);
    expect(snapshot.filesAdded).toEqual([]);
  });

  it('derives testSummary from task.verificationStatus when not provided', () => {
    const extractor = new WorkspaceStateExtractor();
    const passed = extractor.extract({
      task: makeTask({ verificationStatus: 'passed' }),
      repo: makeRepo(),
      snapshotId: 's',
    });
    const failed = extractor.extract({
      task: makeTask({ verificationStatus: 'failed' }),
      repo: makeRepo(),
      snapshotId: 's',
    });
    const required = extractor.extract({
      task: makeTask({ verificationStatus: 'required' }),
      repo: makeRepo(),
      snapshotId: 's',
    });
    expect(passed.testSummary).toBe('passed');
    expect(failed.testSummary).toBe('failed');
    expect(required.testSummary).toBe('required');
  });

  it('honors explicit summary inputs over derived values', () => {
    const extractor = new WorkspaceStateExtractor();
    const snapshot = extractor.extract({
      task: makeTask({ verificationStatus: 'passed' }),
      repo: makeRepo({ filesChanged: ['x'] }),
      buildSummary: 'build passed',
      testSummary: 'explicit-test',
      lintSummary: 'lint clean',
      gitSummary: 'custom-summary',
      snapshotId: 'snap-explicit',
    });

    expect(snapshot.gitSummary).toBe('custom-summary');
    expect(snapshot.buildSummary).toBe('build passed');
    expect(snapshot.testSummary).toBe('explicit-test');
    expect(snapshot.lintSummary).toBe('lint clean');
  });

  it('encodes diagnostic count in derived gitSummary', () => {
    const extractor = new WorkspaceStateExtractor();
    const snapshot = extractor.extract({
      task: makeTask(),
      repo: makeRepo({
        filesChanged: ['src/a.ts'],
        recentDiagnostics: ['edit_file: ENOENT', 'edit_file: ENOENT'],
      }),
      snapshotId: 's',
    });
    expect(snapshot.gitSummary).toBe('M:1 diag:2');
  });
});
