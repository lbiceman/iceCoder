import { describe, expect, it } from 'vitest';

import {
  canVerifyDeliverableKind,
  classifyChangedFiles,
  fileDeliverablePaths,
  hasUnfulfilledFileDeliverableGoal,
  isEngineeringDeliverablePath,
  isFileDeliverableOrientedTask,
  isNonEmptyFileInfoOutput,
  pathsReferToSameFile,
} from '../../src/harness/document-deliverable.js';
import { TaskState } from '../../src/harness/task-state.js';

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

  it('fileDeliverablePaths includes all non-engineering changed files', () => {
    expect(fileDeliverablePaths(['a.md', 'b.tmp'])).toEqual(['a.md', 'b.tmp']);
    expect(fileDeliverablePaths(['src/a.ts', 'notes.bak'])).toEqual([]);
  });

  it('matches paths across separators and casing', () => {
    expect(pathsReferToSameFile(
      'C:\\Users\\tpln\\Desktop\\doc.md',
      'c:/users/tpln/desktop/doc.md',
    )).toBe(true);
  });

  it('file_deliverable verification uses read tools not run_command', () => {
    expect(canVerifyDeliverableKind('file_deliverable', ['file_info', 'read_file'])).toBe(true);
    expect(canVerifyDeliverableKind('file_deliverable', ['run_command'])).toBe(false);
    expect(canVerifyDeliverableKind('engineering', ['run_command'])).toBe(true);
  });

  it('none kind allows run_command retry when verification pending or failed', () => {
    expect(canVerifyDeliverableKind('none', ['run_command'], 'failed')).toBe(true);
    expect(canVerifyDeliverableKind('none', ['run_command'], 'required')).toBe(true);
    expect(canVerifyDeliverableKind('none', ['run_command'], 'not_required')).toBe(false);
    expect(canVerifyDeliverableKind('none', ['file_info'], 'failed')).toBe(false);
  });

  it('parses non-empty file_info output', () => {
    expect(isNonEmptyFileInfoOutput(JSON.stringify({ size: 50143, type: 'file' }))).toBe(true);
    expect(isNonEmptyFileInfoOutput(JSON.stringify({ size: 0, type: 'file' }))).toBe(false);
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

describe('TaskState file deliverable verification', () => {
  it('passes verification after file_info confirms written md', () => {
    const state = new TaskState('整理成 md 放到桌面');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'C:\\Desktop\\AntDesignVue组件文档.md' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.deliverableKind()).toBe('file_deliverable');

    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'C:\\Desktop\\AntDesignVue组件文档.md' } },
      { success: true, output: JSON.stringify({ size: 50143, type: 'file' }) },
    );

    expect(state.snapshot().verificationStatus).toBe('passed');
    expect(state.isVerificationBlockingFinal()).toBe(false);
  });

  it('passes verification for unknown extension via file_info', () => {
    const state = new TaskState('写临时文件');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'C:\\temp\\cache.tmp' } },
      { success: true, output: 'ok' },
    );
    expect(state.deliverableKind()).toBe('file_deliverable');

    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'C:\\temp\\cache.tmp' } },
      { success: true, output: JSON.stringify({ size: 128, type: 'file' }) },
    );
    expect(state.snapshot().verificationStatus).toBe('passed');
  });

  it('passes verification for cleanup.ps1 via file_info', () => {
    const state = new TaskState('写清理脚本');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'C:\\scripts\\cleanup.ps1' } },
      { success: true, output: 'ok' },
    );
    expect(state.deliverableKind()).toBe('file_deliverable');

    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'C:\\scripts\\cleanup.ps1' } },
      { success: true, output: JSON.stringify({ size: 512, type: 'file' }) },
    );
    expect(state.snapshot().verificationStatus).toBe('passed');
  });

  it('passes verification for extensionless LICENSE via file_info', () => {
    const state = new TaskState('添加 LICENSE');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/repo/LICENSE' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: '/repo/LICENSE' } },
      { success: true, output: JSON.stringify({ size: 200, type: 'file' }) },
    );
    expect(state.snapshot().verificationStatus).toBe('passed');
  });

  it('does not pass when read happened before write', () => {
    const state = new TaskState('更新文档');
    state.recordToolResult(
      { id: 'r1', name: 'read_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: '# old content' },
    );
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: 'ok' },
    );

    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.areAllFileDeliverablesConfirmed()).toBe(false);
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('requires re-confirm after rewrite', () => {
    const state = new TaskState('更新文档');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: '/tmp/out.md' } },
      { success: true, output: JSON.stringify({ size: 10, type: 'file' }) },
    );
    expect(state.snapshot().verificationStatus).toBe('passed');

    state.recordToolResult(
      { id: 'w2', name: 'append_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: 'ok' },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
    expect(state.isVerificationBlockingFinal()).toBe(true);
  });

  it('requires all multi-file deliverables confirmed', () => {
    const state = new TaskState('写两份报告');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/tmp/a.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'w2', name: 'write_file', arguments: { path: '/tmp/b.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: '/tmp/a.md' } },
      { success: true, output: JSON.stringify({ size: 10, type: 'file' }) },
    );

    expect(state.areAllFileDeliverablesConfirmed()).toBe(false);
    expect(state.isVerificationBlockingFinal()).toBe(true);

    state.recordToolResult(
      { id: 'f2', name: 'file_info', arguments: { path: '/tmp/b.md' } },
      { success: true, output: JSON.stringify({ size: 12, type: 'file' }) },
    );
    expect(state.snapshot().verificationStatus).toBe('passed');
  });

  it('still requires npm test when code and doc both changed', () => {
    const state = new TaskState('fix bug and update readme');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'README.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'w2', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(state.deliverableKind()).toBe('engineering');
    expect(state.isVerificationBlockingFinal()).toBe(true);

    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'README.md' } },
      { success: true, output: JSON.stringify({ size: 100, type: 'file' }) },
    );
    expect(state.snapshot().verificationStatus).toBe('required');
  });

  it('reconcileFileDeliverablesAfterWrite passes when write followed by read', () => {
    const state = new TaskState('生成报告');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'r1', name: 'read_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: '# Title\n\nbody' },
    );
    expect(state.reconcileFileDeliverablesAfterWrite()).toBe(true);
    expect(state.snapshot().verificationStatus).toBe('passed');
  });

  it('snapshot persists write versions across restore', () => {
    const state = new TaskState('doc task');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'w2', name: 'append_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: 'ok' },
    );
    state.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: '/tmp/out.md' } },
      { success: true, output: JSON.stringify({ size: 12, type: 'file' }) },
    );
    const snap = state.snapshot();
    expect(snap.fileDeliverableWriteVersions?.['/tmp/out.md']).toBe(2);
    expect(snap.fileDeliverableConfirmVersions?.['/tmp/out.md']).toBe(2);

    const restored = new TaskState('other');
    restored.applySnapshot(snap);
    expect(restored.snapshot().verificationStatus).toBe('passed');
    expect(restored.isVerificationBlockingFinal()).toBe(false);
    expect(restored.areAllFileDeliverablesConfirmed()).toBe(true);
  });

  it('isVerificationBlockingFinal is side-effect free', () => {
    const state = new TaskState('写文档');
    state.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: '/tmp/out.md' } },
      { success: true, output: 'ok' },
    );
    const before = state.snapshot();
    expect(state.isVerificationBlockingFinal()).toBe(true);
    expect(state.snapshot()).toEqual(before);
  });
});
