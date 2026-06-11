import { describe, expect, it } from 'vitest';

import {
  canVerifyDeliverableKind,
  classifyChangedFiles,
  deliverableVersionFromMap,
  engineeringTestTargetPaths,
  fileDeliverablePaths,
  gateConfirmationPaths,
  hasUnconfirmedFileDeliverables,
  hasUnfulfilledFileDeliverableGoal,
  isDotPrefixedDirPath,
  isEngineeringDeliverablePath,
  isEphemeralScriptPath,
  isGenericTempPath,
  isMissingFileToolResult,
  isVerificationExemptPath,
  extractDeletedPathsFromCommand,
  isFileDeliverableOrientedTask,
  isNonEmptyFileInfoOutput,
  pathsReferToSameFile,
  snapshotHasUnconfirmedFileDeliverables,
  verificationConfirmationStats,
  writeConfirmationPaths,
} from '../../src/harness/document-deliverable.js';
import { TaskState } from '../../src/harness/task-state.js';
import { resetVerificationExemptRuntime } from '../../src/harness/verification-exempt-config.js';

afterEach(() => {
  resetVerificationExemptRuntime();
});

describe('document-deliverable', () => {
  it('classifies known document extensions as file_deliverable', () => {
    expect(classifyChangedFiles(['C:\\Users\\a\\doc.md'])).toBe('file_deliverable');
    expect(classifyChangedFiles(['/tmp/report.pdf', 'notes.txt'])).toBe('file_deliverable');
  });

  it('classifies unknown extensions and extensionless files as file_deliverable', () => {
    expect(classifyChangedFiles(['/tmp/cache.tmp'])).toBe('file_deliverable');
    expect(classifyChangedFiles(['/repo/LICENSE'])).toBe('file_deliverable');
    expect(classifyChangedFiles(['/repo/Makefile'])).toBe('file_deliverable');
    expect(classifyChangedFiles(['C:\\scripts\\cleanup.ps1'])).toBe('file_deliverable');
    expect(classifyChangedFiles(['backup.bak'])).toBe('file_deliverable');
  });

  it('classifies data/config extensions as file_deliverable not engineering', () => {
    expect(classifyChangedFiles(['/tmp/output.json'])).toBe('file_deliverable');
    expect(classifyChangedFiles(['/tmp/dump.sql'])).toBe('file_deliverable');
    expect(classifyChangedFiles(['config.yaml'])).toBe('file_deliverable');
    expect(isEngineeringDeliverablePath('package.json')).toBe(false);
  });

  it('classifies mixed or code changes as engineering', () => {
    expect(classifyChangedFiles(['src/a.ts', 'README.md'])).toBe('engineering');
    expect(classifyChangedFiles(['src/a.ts'])).toBe('engineering');
    expect(classifyChangedFiles(['src/a.ts', 'notes.bak'])).toBe('engineering');
    expect(classifyChangedFiles(['src/a.ts', 'package.json'])).toBe('engineering');
  });

  it('writeConfirmationPaths excludes temp/scratch paths from gate', () => {
    expect(writeConfirmationPaths(['a.md', 'b.tmp'])).toEqual(['a.md']);
    expect(writeConfirmationPaths(['src/a.ts', 'notes.bak'])).toEqual(['src/a.ts']);
    expect(writeConfirmationPaths(['src/a.ts', 'README.md'])).toEqual(['src/a.ts', 'README.md']);
    expect(writeConfirmationPaths(['src/a.ts'])).toEqual(['src/a.ts']);
    expect(writeConfirmationPaths([])).toEqual([]);
  });

  it('isVerificationExemptPath: generic temp suffixes and workspace tmp/', () => {
    expect(isGenericTempPath('backup.bak')).toBe(true);
    expect(isGenericTempPath('scratch.tmp')).toBe(true);
    expect(isGenericTempPath('/tmp/out.md')).toBe(false);
    expect(isGenericTempPath('tmp/draft/out.md')).toBe(true);
    expect(isGenericTempPath('cache/session/out.json')).toBe(true);
    expect(isVerificationExemptPath('README.md')).toBe(false);
  });

  it('isVerificationExemptPath: ephemeral diagnostic scripts', () => {
    expect(isVerificationExemptPath('D:/tools/JDK11/elevate.ps1')).toBe(true);
    expect(isVerificationExemptPath('D:/tools/JDK11/check-reg.ps1')).toBe(true);
    expect(isVerificationExemptPath('D:/tools/JDK11/fresh-test.ps1')).toBe(true);
    expect(isVerificationExemptPath('scripts/cleanup.ps1')).toBe(true);
    expect(isVerificationExemptPath('scripts/fix-tasks.cjs')).toBe(false);
    expect(writeConfirmationPaths(['README.md', 'elevate.ps1'])).toEqual(['README.md']);
  });

  it('gateConfirmationPaths keeps pending write paths even when file missing on disk', () => {
    const missing = 'missing-gate-file-xyz123.md';
    expect(gateConfirmationPaths([missing], process.cwd())).toEqual([]);
    expect(gateConfirmationPaths(
      [missing],
      process.cwd(),
      { [missing]: 1 },
      {},
    )).toEqual([missing]);
    expect(hasUnconfirmedFileDeliverables(
      [missing],
      { [missing]: 1 },
      {},
      process.cwd(),
    )).toBe(true);
    expect(writeConfirmationPaths([missing])).toEqual([missing]);
  });

  it('gateConfirmationPaths excludes confirmed-then-deleted files on disk', () => {
    const missing = 'missing-gate-file-xyz123.md';
    expect(gateConfirmationPaths(
      [missing],
      process.cwd(),
      { [missing]: 1 },
      { [missing]: 1 },
    )).toEqual([]);
  });

  it('isMissingFileToolResult detects ENOENT errors', () => {
    expect(isMissingFileToolResult({ success: false, output: '', error: 'ENOENT: no such file' })).toBe(true);
    expect(isMissingFileToolResult({ success: false, output: 'file not found', error: '' })).toBe(true);
    expect(isMissingFileToolResult({ success: true, output: 'ok' })).toBe(false);
  });

  it('isVerificationExemptPath: dot-prefixed directory segments', () => {
    expect(isDotPrefixedDirPath('E:/proj/.scratch/draft.md')).toBe(true);
    expect(isDotPrefixedDirPath('E:/proj/src/.cache/x.ts')).toBe(true);
    expect(isVerificationExemptPath('E:/proj/.scratch/draft.md')).toBe(true);
    expect(isDotPrefixedDirPath('E:/proj/scripts/fix-tasks.cjs')).toBe(false);
    expect(isVerificationExemptPath('E:/proj/scripts/fix-tasks.cjs')).toBe(false);
    expect(isDotPrefixedDirPath('E:/proj/.env')).toBe(false);
  });

  it('verificationConfirmationStats counts only required paths', () => {
    const files = [
      'src/a.ts',
      '.scratch/draft.md',
      'scripts/fix-tasks.cjs',
    ];
    const stats = verificationConfirmationStats(
      files,
      { 'src/a.ts': 1, 'scripts/fix-tasks.cjs': 1 },
      {},
    );
    expect(stats.exempt).toBe(1);
    expect(stats.required).toBe(2);
    expect(stats.pending).toBe(2);
    expect(hasUnconfirmedFileDeliverables(files, { 'src/a.ts': 1, 'scripts/fix-tasks.cjs': 1 }, {})).toBe(true);
  });

  it('canVerifyDeliverableKind passes when only dot-dir exempt files changed', () => {
    expect(canVerifyDeliverableKind(['.scratch/out.md'], ['file_info'])).toBe(true);
  });

  it('fileDeliverablePaths still excludes engineering for deliverable classification', () => {
    expect(fileDeliverablePaths(['src/a.ts', 'notes.bak'])).toEqual(['notes.bak']);
    expect(fileDeliverablePaths(['src/a.ts'])).toEqual([]);
  });

  it('canVerifyDeliverableKind for engineering pending requires run_command', () => {
    expect(canVerifyDeliverableKind(['a.md'], ['run_command'], false, 'required')).toBe(true);
    expect(canVerifyDeliverableKind(['src/a.ts'], ['run_command'], false, 'required')).toBe(true);
    expect(canVerifyDeliverableKind(['src/a.ts'], ['read_file'], false, 'required')).toBe(false);
    expect(canVerifyDeliverableKind(['src/a.ts'], ['run_command'], false, 'passed')).toBe(true);
  });

  it('matches paths across separators and casing', () => {
    expect(pathsReferToSameFile(
      'C:\\Users\\tpln\\Desktop\\doc.md',
      'c:/users/tpln/desktop/doc.md',
    )).toBe(true);
  });

  it('extracts deleted paths from shell delete commands', () => {
    expect(extractDeletedPathsFromCommand(
      'del "E:\\test\\proj\\generate-assets.mjs" 2>nul || echo done',
    )).toEqual(['E:\\test\\proj\\generate-assets.mjs']);
    expect(extractDeletedPathsFromCommand(
      'rm E:/test/proj/generate-assets.mjs 2>&1 && echo OK',
    )).toEqual(['E:/test/proj/generate-assets.mjs']);
    expect(extractDeletedPathsFromCommand(
      'cd /d E:\\test\\proj && del generate-assets.mjs',
    )).toEqual(['generate-assets.mjs']);
    expect(extractDeletedPathsFromCommand('npm test')).toEqual([]);
  });

  it('acceptance gate pending requires run_command', () => {
    expect(canVerifyDeliverableKind([], ['run_command'], true)).toBe(true);
    expect(canVerifyDeliverableKind(['a.md'], ['file_info'], true)).toBe(false);
  });

  it('hasUnconfirmedFileDeliverables uses write/confirm version maps', () => {
    expect(hasUnconfirmedFileDeliverables(['a.md'], { 'a.md': 1 }, { 'a.md': 1 })).toBe(false);
    expect(hasUnconfirmedFileDeliverables(['a.md'], { 'a.md': 1 }, {})).toBe(true);
    expect(hasUnconfirmedFileDeliverables(['a.md'], { 'a.md': 2 }, { 'a.md': 1 })).toBe(true);
    expect(hasUnconfirmedFileDeliverables(['src/a.ts'], { 'src/a.ts': 1 }, {})).toBe(true);
    expect(hasUnconfirmedFileDeliverables(['src/a.ts'], { 'src/a.ts': 1 }, { 'src/a.ts': 1 })).toBe(false);

    expect(snapshotHasUnconfirmedFileDeliverables({
      goal: 'g', intent: 'edit', phase: 'editing',
      filesRead: [], filesChanged: ['README.md'],
      commandsRun: ['npm test'], verificationRequired: true, verificationStatus: 'passed',
      fileDeliverableWriteVersions: { 'readme.md': 1 },
      fileDeliverableConfirmVersions: {},
    })).toBe(true);
  });

  it('parses file_info output including zero-byte files', () => {
    expect(isNonEmptyFileInfoOutput(JSON.stringify({ size: 50143, type: 'file' }))).toBe(true);
    expect(isNonEmptyFileInfoOutput(JSON.stringify({ size: 0, type: 'file' }))).toBe(true);
    expect(isNonEmptyFileInfoOutput(JSON.stringify({ size: 0, type: 'directory' }))).toBe(false);
  });

  it('empty read_file output still tracks deliverable confirm version', () => {
    const state = new TaskState('写占位文件');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'empty.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'r1', name: 'read_file', arguments: { path: 'empty.md' } },
      { success: true, output: '' },
    );
    expect(state.areAllFileDeliverablesConfirmed()).toBe(true);
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('deliverableVersionFromMap matches non-normalized map keys', () => {
    const map = new Map<string, number>([['README.md', 3]]);
    expect(deliverableVersionFromMap(map, 'readme.md')).toBe(3);
  });

  it('shell scripts are file_deliverable not engineering', () => {
    expect(isEngineeringDeliverablePath('run.ps1')).toBe(false);
    expect(isEngineeringDeliverablePath('deploy.sh')).toBe(false);
    expect(classifyChangedFiles(['cleanup.ps1'])).toBe('file_deliverable');
  });

  it('detects file-deliverable-oriented goals without intent=docs', () => {
    expect(isFileDeliverableOrientedTask('把 ant design 整理成 md 文档放到桌面', [])).toBe(true);
    expect(isFileDeliverableOrientedTask('fix login bug', [])).toBe(false);
  });

  it('hasUnfulfilledFileDeliverableGoal blocks write goals without files', () => {
    expect(hasUnfulfilledFileDeliverableGoal('整理成 md 放到桌面', [], 'edit')).toBe(true);
    expect(hasUnfulfilledFileDeliverableGoal('解释一下 markdown 语法', [], 'inspect')).toBe(false);
    expect(hasUnfulfilledFileDeliverableGoal('清理 C 盘', [], 'edit')).toBe(false);
    expect(hasUnfulfilledFileDeliverableGoal('整理成 md', ['/tmp/a.md'], 'edit')).toBe(false);
  });

  it('hasUnfulfilledFileDeliverableGoal ignores chat-only report goals', () => {
    expect(hasUnfulfilledFileDeliverableGoal('生成测试报告', [], 'edit')).toBe(false);
    expect(hasUnfulfilledFileDeliverableGoal('write a summary report', [], 'edit')).toBe(false);
    expect(hasUnfulfilledFileDeliverableGoal('帮我写 readme 文档', [], 'docs')).toBe(true);
  });
});

describe('TaskState engineering unit test gate', () => {
  it('md-only changes do not block verification gate', () => {
    const state = new TaskState('整理成 md 放到桌面');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'C:\\Desktop\\doc.md' } },
      { success: true, output: 'ok' },
    );
    expect(state.deliverableKind()).toBe('file_deliverable');
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('file_info on md does not auto-pass verificationStatus', () => {
    const state = new TaskState('整理成 md 放到桌面');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'C:\\Desktop\\doc.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'C:\\Desktop\\doc.md' } },
      { success: true, output: JSON.stringify({ size: 50143, type: 'file' }) },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.areAllFileDeliverablesConfirmed()).toBe(true);
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('engineering changes block until unit test passes', () => {
    const state = new TaskState('fix bug');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.isVerificationBlockingFinal()).toBe(true);

    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'all passed' },
    );
    expect(state.snapshot().verificationStatus).toBe('passed');
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('read_file after engineering edit does not unblock gate', () => {
    const state = new TaskState('fix bug');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'r1', name: 'read_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'export const x = 1;' },
    );
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('failed unit test does not block gate (soft reminder only)', () => {
    const state = new TaskState('fix bug');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: '', error: 'exit 1' },
    );
    expect(state.snapshot().verificationStatus).toBe('failed');
    expect(state.isVerificationBlockingFinal()).toBe(false);
    expect(state.shouldInjectFailedUnitTestReminder()).toBe(true);
  });

  it('rewrite after failed test resets to required', () => {
    const state = new TaskState('fix bug');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: 'FAIL', error: 'exit 1' },
    );
    expect(state.snapshot().verificationStatus).toBe('failed');
    state.recordToolResult(
      { id: 'w2', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.isVerificationBlockingFinal()).toBe(true);
    expect(state.shouldInjectFailedUnitTestReminder()).toBe(false);
  });

  it('npm run lint success does not mark verification passed', () => {
    const state = new TaskState('fix');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm run lint' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('background npm test start keeps verification required', () => {
    const state = new TaskState('fix');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    const bgOutput = JSON.stringify({ mode: 'background', task_id: 'bg_1' });
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: bgOutput },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('css-only changes do not trigger unit test gate', () => {
    const state = new TaskState('style');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.css' } },
      { success: true, output: 'ok' },
    );
    expect(engineeringTestTargetPaths(state.snapshot().filesChanged)).toEqual([]);
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('rewrite after passed test resets to required', () => {
    const state = new TaskState('fix bug');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'w2', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('mixed code and doc: blocks until test passes not read confirm', () => {
    const state = new TaskState('fix bug and update readme');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'README.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'w2', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.isVerificationBlockingFinal()).toBe(true);

    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'README.md' } },
      { success: true, output: JSON.stringify({ size: 100, type: 'file' }) },
    );
    expect(state.isVerificationBlockingFinal()).toBe(true);

    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'ok' },
    );
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('buildVerificationPrompt lists engineering targets', () => {
    const state = new TaskState('fix');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'w2', name: 'write_file', arguments: { path: 'notes.md' } },
      { success: true, output: 'ok' },
    );
    const prompt = state.buildVerificationPrompt();
    expect(prompt).toMatch(/unit tests/i);
    expect(prompt).toMatch(/src\/a\.ts/);
    expect(prompt).not.toMatch(/notes\.md/);
  });

  it('buildFailedUnitTestReminderPrompt mentions failure', () => {
    const state = new TaskState('fix');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: 'FAIL', error: 'exit 1' },
    );
    expect(state.buildFailedUnitTestReminderPrompt()).toMatch(/Unit tests failed/i);
  });

  it('isVerificationBlockingFinal is side-effect free', () => {
    const state = new TaskState('fix');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    const before = state.snapshot();
    expect(state.isVerificationBlockingFinal()).toBe(true);
    expect(state.snapshot()).toEqual(before);
  });

  it('buildVerificationPrompt lists engineering path missing on disk', () => {
    const state = new TaskState('fix');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/missing.ts' } },
      { success: true, output: 'ok' },
    );
    const prompt = state.buildVerificationPrompt();
    expect(prompt).toMatch(/src\/missing\.ts/);
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('removes engineering path after read_file ENOENT clears gate when no targets left', () => {
    const state = new TaskState('cleanup');
    const path = 'src/missing.ts';
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path } },
      { success: true, output: 'ok' },
    );
    expect(state.isVerificationBlockingFinal()).toBe(true);

    state.recordToolResult(
      { id: 'r1', name: 'read_file', arguments: { path } },
      { success: false, output: '', error: 'ENOENT: no such file or directory' },
    );

    expect(state.snapshot().filesChanged).toEqual([]);
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('removes changed file after fs_operation delete', () => {
    const state = new TaskState('cleanup');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'd1', name: 'fs_operation', arguments: { operation: 'delete', path: 'src/a.ts' } },
      { success: true, output: 'File deleted: src/a.ts' },
    );
    expect(state.snapshot().filesChanged).toEqual([]);
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('reconcileOrphanFileDeliverableWriteVersions still backfills write versions', () => {
    const state = new TaskState('edit task');
    state.applySnapshot({
      goal: 'edit task',
      intent: 'edit',
      phase: 'editing',
      filesRead: [],
      filesChanged: ['js/main.js'],
      commandsRun: [],
      verificationRequired: true,
      verificationStatus: 'required',
      fileDeliverableConfirmVersions: { 'js/main.js': 8 },
    });
    expect(state.snapshot().fileDeliverableWriteVersions?.['js/main.js']).toBe(9);
  });

  it('buildVerificationPrompt does not mutate TaskState', () => {
    const state = new TaskState('fix');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    const before = state.snapshot();
    state.buildVerificationPrompt();
    expect(state.snapshot()).toEqual(before);
  });

  it('mvn test counts as verification command', () => {
    const state = new TaskState('fix java');
    state.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/Main.java' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'mvn test' } },
      { success: true, output: 'BUILD SUCCESS' },
    );
    expect(state.snapshot().verificationStatus).toBe('passed');
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });
});
