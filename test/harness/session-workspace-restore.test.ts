import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureIntentCheckpoint } from '../../src/harness/intent-checkpoint-capture.js';
import { rewriteIntentCheckpoint } from '../../src/harness/intent-checkpoint-store.js';
import {
  buildSessionWorkspaceRestoreSnapshot,
  collectExistedRelPathsAtCheckpoint,
  collectWrittenRelPathsAfterMessage,
  collectWrittenRelPathsBeforeMessage,
  isNewFileUnifiedDiff,
  revertContentUsingUnifiedDiff,
} from '../../src/harness/session-workspace-restore.js';
import { buildFileChangeDiff } from '../../src/tools/file-change-diff.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ice-ws-restore-'));
}

describe('session-workspace-restore', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reverts file content using unified diff from tool output', () => {
    const oldContent = '--accent: #39D1E0;\n--accent-hover: #5edae7;';
    const newContent = '--accent: #3BEA7C;\n--accent-hover: #6cf0a0;';
    const diff = buildFileChangeDiff(oldContent, newContent, 'src/public/css/tokens.css');
    expect(diff).toBeTruthy();

    const reverted = revertContentUsingUnifiedDiff(newContent, diff!);
    expect(reverted).toBe(oldContent);
  });

  it('reverts a local hunk against the full current file instead of concatenating old lines', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    const newLines = [...oldLines];
    newLines[9] = 'line-10-changed';
    const oldContent = oldLines.join('\n');
    const newContent = newLines.join('\n');
    const diff = buildFileChangeDiff(oldContent, newContent, 'big.txt');
    expect(diff).toBeTruthy();

    const reverted = revertContentUsingUnifiedDiff(newContent, diff!);
    expect(reverted).toBe(oldContent);
  });

  it('treats write_file empty-old-line diffs as new files, not /dev/null', () => {
    const diff = buildFileChangeDiff('', '这是一个简单的文本文件。', '1.txt');
    expect(diff).toBeTruthy();
    expect(diff).not.toContain('/dev/null');
    expect(isNewFileUnifiedDiff(diff!)).toBe(true);
    expect(isNewFileUnifiedDiff('--- /dev/null\n+++ 1.txt\n@@ -0,0 +1 @@\n+hi\n')).toBe(true);

    const editDiff = buildFileChangeDiff('old line\n', 'new line\n', '1.txt');
    expect(isNewFileUnifiedDiff(editDiff!)).toBe(false);
  });

  it('marks later write_file creates as null so restore deletes them', async () => {
    const sessionId = 'sess-ws-create';
    const messageId = 'user-msg-1';
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(locked, '1.txt'), '这是一个简单的文本文件。', 'utf-8');

    const captured = await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: locked,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '新增一个空文件' }],
      uiMessages: [{ role: 'user', content: '新增一个空文件', id: messageId, sentAt: 1000 }],
    });

    const diff = buildFileChangeDiff('', '这是一个简单的文本文件。', '1.txt');
    const snapshot = await buildSessionWorkspaceRestoreSnapshot({
      archive: captured.archive,
      sessionDir: tmp,
      sessionId,
      workspaceRoot: locked,
      currentUiMessages: [
        { role: 'user', content: '新增一个空文件', id: messageId, sentAt: 1000 },
        {
          role: 'tool_trace',
          toolName: 'write_file',
          detail: 'test/agentToolTest/20260910/1.txt',
          status: 'success',
          toolCallId: 'call-1',
          diffSource: diff || undefined,
        },
      ],
    });

    expect(snapshot['1.txt']).toBeNull();
    expect(snapshot['test/agentToolTest/20260910/1.txt']).toBeUndefined();
  });

  it('keeps reconstructed content when a later turn edited a pre-existing file', async () => {
    const sessionId = 'sess-ws-edit';
    const messageId = 'user-msg-1';
    const filePath = 'tokens.css';
    await fs.writeFile(path.join(tmp, filePath), '--accent: #old;', 'utf-8');

    const captured = await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '改色' }],
      uiMessages: [{ role: 'user', content: '改色', id: messageId, sentAt: 1000 }],
    });

    const diff = buildFileChangeDiff('--accent: #old;', '--accent: #new;', filePath);
    const snapshot = await buildSessionWorkspaceRestoreSnapshot({
      archive: captured.archive,
      sessionDir: tmp,
      sessionId,
      workspaceRoot: tmp,
      currentUiMessages: [
        { role: 'user', content: '改色', id: messageId, sentAt: 1000 },
        {
          role: 'tool_trace',
          toolName: 'write_file',
          detail: filePath,
          status: 'success',
          diffSource: diff || undefined,
        },
      ],
    });

    expect(snapshot[filePath]).toBe('--accent: #old;');
  });

  it('collects fs_operation write paths after the target message', () => {
    const root = path.join(tmp, 'test', 'agentToolTest', '20260910');
    const paths = collectWrittenRelPathsAfterMessage(
      [
        { role: 'user', id: 'msg-1', content: '先建空文件' },
        { role: 'tool_trace', toolName: 'write_file', detail: 'empty.txt', status: 'success' },
        { role: 'user', id: 'msg-2', content: '再建 1.txt' },
        {
          role: 'tool_trace',
          toolName: 'fs_operation',
          detail: 'test/agentToolTest/20260910/1.txt',
          status: 'success',
        },
        {
          role: 'tool_trace',
          toolName: 'fs_operation',
          detail: '.',
          status: 'success',
        },
      ],
      'msg-1',
      root,
    );
    expect(paths).toContain('empty.txt');
    expect(paths).toContain('1.txt');
    expect(paths).not.toContain('.');
    expect(paths).not.toContain('');
  });

  it('collects write paths before the target message as already-existing files', () => {
    const root = path.join(tmp, 'test', 'agentToolTest', '20260910');
    const before = collectWrittenRelPathsBeforeMessage(
      [
        { role: 'user', id: 'msg-1', content: '先建空文件' },
        { role: 'tool_trace', toolName: 'write_file', detail: 'empty.txt', status: 'success' },
        { role: 'user', id: 'msg-2', content: '再建 1.txt' },
        { role: 'tool_trace', toolName: 'write_file', detail: '1.txt', status: 'success' },
      ],
      'msg-2',
      root,
    );
    expect(before).toEqual(['empty.txt']);
  });

  it('does not treat the whole session as after-target when the message id is missing', () => {
    const root = path.join(tmp, 'test', 'agentToolTest', '20260910');
    const ui = [
      { role: 'user', id: 'msg-1', content: '先建空文件' },
      { role: 'tool_trace', toolName: 'write_file', detail: 'empty.txt', status: 'success' },
      { role: 'user', id: 'msg-2', content: '再建 1.txt' },
      { role: 'tool_trace', toolName: 'write_file', detail: '1.txt', status: 'success' },
    ];
    expect(collectWrittenRelPathsAfterMessage(ui, 'already-stable-id', root)).toEqual([]);
    expect(collectWrittenRelPathsBeforeMessage(ui, 'already-stable-id', root)).toEqual([]);
    expect(collectWrittenRelPathsAfterMessage(ui, 'already-stable-id', root, {
      version: 1,
      messageId: 'already-stable-id',
      sessionId: 's',
      createdAt: new Date().toISOString(),
      userMessageTime: 2000,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: root,
      workspaceFiles: {},
      trackedPaths: [],
      structuredMessages: [],
      uiMessages: [{ role: 'user', id: 'already-stable-id', content: '再建 1.txt' }],
    })).toEqual(['1.txt']);
  });

  it('does not treat a later empty-old write as create when the file already existed', async () => {
    const sessionId = 'sess-ws-existed';
    const msg1 = 'user-msg-1';
    const msg2 = 'user-msg-2';
    await fs.writeFile(path.join(tmp, 'empty.txt'), 'later-overwrite', 'utf-8');

    const captured = await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      userMessageTime: 2000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '改空文件' }],
      uiMessages: [{ role: 'user', content: '改空文件', id: msg2, sentAt: 2000 }],
    });
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...captured.archive,
      workspaceFiles: {},
      trackedPaths: [],
    });

    const overwriteDiff = buildFileChangeDiff('', 'later-overwrite', 'empty.txt');
    const snapshot = await buildSessionWorkspaceRestoreSnapshot({
      archive: { ...captured.archive, workspaceFiles: {} },
      sessionDir: tmp,
      sessionId,
      workspaceRoot: tmp,
      currentUiMessages: [
        { role: 'user', content: '新增空文件', id: msg1, sentAt: 1000 },
        { role: 'tool_trace', toolName: 'write_file', detail: 'empty.txt', status: 'success' },
        { role: 'user', content: '改空文件', id: msg2, sentAt: 2000 },
        {
          role: 'tool_trace',
          toolName: 'write_file',
          detail: 'empty.txt',
          status: 'success',
          diffSource: overwriteDiff || undefined,
        },
      ],
    });

    expect(snapshot['empty.txt']).toBe('');
  });

  it('recovers omitted checkpoint content from a neighboring archive', async () => {
    const sessionId = 'sess-recover';
    const msg1 = 'user-msg-1';
    const msg2 = 'user-msg-2';
    const first = await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg1,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '先写诗' }],
      uiMessages: [{ role: 'user', content: '先写诗', id: msg1, sentAt: 1000 }],
    });
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...first.archive,
      workspaceFiles: { 'poem.txt': '床前明月光' },
      trackedPaths: ['poem.txt'],
    });

    const second = await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      userMessageTime: 2000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '再改一改' }],
      uiMessages: [
        { role: 'user', content: '先写诗', id: msg1, sentAt: 1000 },
        { role: 'user', content: '再改一改', id: msg2, sentAt: 2000 },
      ],
    });
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...second.archive,
      workspaceFiles: {},
      trackedPaths: [],
    });

    const snapshot = await buildSessionWorkspaceRestoreSnapshot({
      archive: { ...second.archive, workspaceFiles: {} },
      sessionDir: tmp,
      sessionId,
      workspaceRoot: tmp,
      currentUiMessages: [
        { role: 'user', content: '先写诗', id: msg1, sentAt: 1000 },
        { role: 'user', content: '再改一改', id: msg2, sentAt: 2000 },
      ],
    });

    expect(snapshot['poem.txt']).toBe('床前明月光');
  });

  it('does not treat earlier null snapshot keys as files that already existed', async () => {
    const sessionId = 'sess-existed-null';
    const msg1 = 'user-msg-1';
    const msg2 = 'user-msg-2';
    const first = await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg1,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '先建空文件' }],
      uiMessages: [{ role: 'user', content: '先建空文件', id: msg1, sentAt: 1000 }],
    });
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...first.archive,
      workspaceFiles: { 'empty.txt': '', '1.txt': null },
      trackedPaths: ['empty.txt', '1.txt'],
    });

    const second = await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      userMessageTime: 2000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '再建 1.txt' }],
      uiMessages: [
        { role: 'user', content: '先建空文件', id: msg1, sentAt: 1000 },
        { role: 'user', content: '再建 1.txt', id: msg2, sentAt: 2000 },
      ],
    });
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...second.archive,
      workspaceFiles: { '1.txt': null },
      trackedPaths: ['1.txt'],
    });

    const uiMessages = [
      { role: 'user' as const, content: '先建空文件', id: msg1, sentAt: 1000 },
      { role: 'tool_trace' as const, toolName: 'write_file', detail: 'empty.txt', status: 'success' },
      { role: 'user' as const, content: '再建 1.txt', id: msg2, sentAt: 2000 },
      { role: 'tool_trace' as const, toolName: 'write_file', detail: '1.txt', status: 'success' },
    ];
    const existed = await collectExistedRelPathsAtCheckpoint({
      archive: { ...second.archive, workspaceFiles: { '1.txt': null } },
      sessionDir: tmp,
      sessionId,
      workspaceRoot: tmp,
      snapshot: { '1.txt': null },
      uiMessages,
    });

    expect(existed.has('empty.txt')).toBe(true);
    expect(existed.has('1.txt')).toBe(false);
  });
});
