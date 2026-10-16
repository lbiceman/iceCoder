import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkToolPreflight,
  isDistArtifactPath,
} from '../../src/harness/harness-tool-preflight.js';
import { CompletionFactsView } from '../../src/harness/completion-facts-view.js';

describe('harness-tool-preflight', () => {
  it('blocks read_file on dist when verification failed', () => {
    const decision = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'dist/src/scenes/MapSelectScene.js' },
      completionFacts: CompletionFactsView.fromCompletionSnapshot({
        conditions: [{
          id: 'verification:test',
          label: 'tests',
          required: true,
          status: 'failed',
          source: 'user',
          sourceRef: 'verification:test',
          evidenceRefs: [],
        }],
        operationOutcomes: [],
      }),
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('dist_read');
    expect(isDistArtifactPath('build/out.js')).toBe(true);
  });

  it('blocks repeated read_file when target missing on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    const attempts = new Map<string, number>();
    attempts.set('src/scenes/MapSelectScene.ts', 1);

    const blocked = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'src/scenes/MapSelectScene.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
      missingFileAttempts: attempts,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('missing_file_repeat');
    expect(blocked.message).toMatch(/STOP/);
  });

  it('allows first read_file on missing path (executor may ENOENT once)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    const attempts = new Map<string, number>();
    const first = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'src/scenes/MapSelectScene.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
      missingFileAttempts: attempts,
    });
    expect(first.blocked).toBe(false);
  });

  it('blocks patch_file when target missing on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    const attempts = new Map<string, number>();
    const decision = checkToolPreflight({
      toolName: 'patch_file',
      args: { path: 'src/scenes/MapSelectScene.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
      missingFileAttempts: attempts,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('missing_file');
    expect(decision.message).toMatch(/write_file/);
    expect(attempts.get('src/scenes/MapSelectScene.ts')).toBe(1);
  });

  it('allows read_file when file exists on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'ok.ts'), 'export {}');
    const decision = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'src/ok.ts' },
      workspaceRoot: root,
      lockedWorkspaceRoot: root,
    });
    expect(decision.blocked).toBe(false);
  });

  it('blocks run_command that broad-kills node via script', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-preflight-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts', 'kill-all.cjs'),
      "require('child_process').execSync('taskkill /F /IM node.exe');",
      'utf-8',
    );
    const blocked = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'node scripts/kill-all.cjs 2>&1' },
      workspaceRoot: root,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('host_kill');
    expect(blocked.message).toMatch(/HostGuard/);
  });

  it('blocks write_file embedding taskkill /IM node', () => {
    const blocked = checkToolPreflight({
      toolName: 'write_file',
      args: {
        path: 'scripts/fix.cjs',
        content: "execSync('taskkill /F /IM node.exe');",
      },
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('host_kill');
  });

  it('allows taskkill by PID in run_command', () => {
    const allowed = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'taskkill /F /PID 12345' },
    });
    expect(allowed.blocked).toBe(false);
  });

  it('does not pause a command just because it failed before', () => {
    const decision = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'npm run build 2>&1' },
    });
    expect(decision.blocked).toBe(false);
  });
});
