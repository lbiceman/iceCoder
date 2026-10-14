import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureIntentCheckpoint } from '../../src/harness/intent-checkpoint-capture.js';
import {
  hashIntentBlobContent,
  intentCheckpointBlobsDir,
  IntentCheckpointCorruptError,
} from '../../src/harness/intent-checkpoint-blobs.js';
import {
  intentCheckpointArchivePath,
  loadCheckpointIndex,
  loadIntentCheckpoint,
  removeCheckpoint,
  saveIntentCheckpoint,
} from '../../src/harness/intent-checkpoint-store.js';
import { resetHarnessRuntimeRegistry } from '../../src/harness/harness-runtime-registry.js';
import {
  RestoreFailedError,
  RuntimeRestoreCoordinator,
} from '../../src/harness/runtime-restore-coordinator.js';
import { sessionNotesPath } from '../../src/memory/file-memory/session-memory.js';
import type { IntentCheckpointArchive, UiChatMessage } from '../../src/types/intent-checkpoint.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

const SHARED = `共享正文-${'甲'.repeat(80)}\n第二行\n`;
const EMPTY = '';
const CREATED_B = '后来写入的 b';
const NOTES_1 = '笔记-v1\n保留换行\n';
const NOTES_2 = '笔记-v2\n';
const NOTES_3 = '笔记-v3\n';
const TRACE_2 = '{"paths":["a.txt"],"turn":2}\n';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ice-blobs-'));
}

function archive(
  sessionId: string,
  messageId: string,
  workspaceRoot: string,
  fields: Partial<IntentCheckpointArchive> & Pick<IntentCheckpointArchive, 'workspaceFiles' | 'trackedPaths'>,
): IntentCheckpointArchive {
  return {
    version: 1,
    messageId,
    sessionId,
    createdAt: '2026-10-14T00:00:00.000Z',
    userMessageTime: 1,
    workspace: { referenceReads: [], changeCount: 0 },
    workspaceRoot,
    structuredMessages: [],
    uiMessages: [],
    ...fields,
  };
}

async function blobHashes(sessionDir: string, sessionId: string): Promise<string[]> {
  const dir = intentCheckpointBlobsDir(sessionDir, sessionId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
}

describe('intent checkpoint content blobs', () => {
  let tmp: string;
  const sessionId = 'sess-blobs';

  beforeEach(async () => {
    tmp = await makeTempDir();
    resetHarnessRuntimeRegistry();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('stores identical file bodies, messages, and notes once', async () => {
    const user: UiChatMessage = { role: 'user', id: 'u1', content: '第一句', sentAt: 1 };
    const structured: UnifiedMessage = { role: 'user', content: '第一句' };
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u1', tmp, {
        workspaceFiles: { 'a.txt': SHARED, 'copy.txt': SHARED, 'empty.txt': EMPTY, 'gone.txt': null },
        trackedPaths: ['a.txt', 'copy.txt', 'empty.txt', 'gone.txt'],
        uiMessages: [user],
        structuredMessages: [structured],
        sessionNotesContent: NOTES_1,
        toolTraceDiffsRaw: null,
      }),
    });
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u2', tmp, {
        userMessageTime: 2,
        workspaceFiles: { 'a.txt': SHARED, 'copy.txt': SHARED, 'empty.txt': EMPTY, 'gone.txt': null },
        trackedPaths: ['a.txt', 'copy.txt', 'empty.txt', 'gone.txt'],
        uiMessages: [user, { role: 'user', id: 'u2', content: '第二句', sentAt: 2 }],
        structuredMessages: [structured, { role: 'user', content: '第二句' }],
        sessionNotesContent: NOTES_1,
        toolTraceDiffsRaw: TRACE_2,
      }),
    });

    const raw1 = JSON.parse(await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), 'utf-8'));
    const raw2 = JSON.parse(await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u2'), 'utf-8'));
    expect(raw1.storage).toBe('blobs-v1');
    expect(JSON.stringify(raw1)).not.toContain('共享正文');
    expect(JSON.stringify(raw2)).not.toContain('共享正文');
    expect(raw1.workspaceFileRefs['a.txt']).toBe(raw1.workspaceFileRefs['copy.txt']);
    expect(raw1.workspaceFileRefs['a.txt']).toBe(raw2.workspaceFileRefs['a.txt']);
    expect(raw1.workspaceFileRefs['gone.txt']).toBeNull();
    expect(raw1.uiMessageRefs[0]).toBe(raw2.uiMessageRefs[0]);
    expect(raw1.sessionNotesRef).toBe(raw2.sessionNotesRef);
    expect(raw1.toolTraceDiffsRef).toBeNull();
    expect(raw2.toolTraceDiffsRef).toBe(hashIntentBlobContent(TRACE_2));

    const hashes = await blobHashes(tmp, sessionId);
    expect(hashes).toContain(hashIntentBlobContent(SHARED));
    expect(hashes).toContain(hashIntentBlobContent(EMPTY));
    expect(await fs.readFile(
      path.join(intentCheckpointBlobsDir(tmp, sessionId), hashIntentBlobContent(SHARED)),
      'utf-8',
    )).toBe(SHARED);

    const loaded = await loadIntentCheckpoint(tmp, sessionId, 'u2');
    expect(loaded?.workspaceFiles).toEqual({
      'a.txt': SHARED,
      'copy.txt': SHARED,
      'empty.txt': EMPTY,
      'gone.txt': null,
    });
    expect(loaded?.uiMessages.map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(loaded?.sessionNotesContent).toBe(NOTES_1);
    expect(loaded?.toolTraceDiffsRaw).toBe(TRACE_2);
  });

  it('drops blobs that no remaining checkpoint references', async () => {
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u1', tmp, {
        workspaceFiles: { 'a.txt': SHARED },
        trackedPaths: ['a.txt'],
        sessionNotesContent: NOTES_1,
      }),
    });
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u2', tmp, {
        workspaceFiles: { 'a.txt': SHARED, 'b.txt': CREATED_B },
        trackedPaths: ['a.txt', 'b.txt'],
        sessionNotesContent: NOTES_2,
      }),
    });

    await removeCheckpoint(tmp, sessionId, 'u2');

    const hashes = await blobHashes(tmp, sessionId);
    expect(hashes).toContain(hashIntentBlobContent(SHARED));
    expect(hashes).toContain(hashIntentBlobContent(NOTES_1));
    expect(hashes).not.toContain(hashIntentBlobContent(CREATED_B));
    expect(hashes).not.toContain(hashIntentBlobContent(NOTES_2));
    const kept = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    expect(kept?.workspaceFiles['a.txt']).toBe(SHARED);
    expect(kept?.sessionNotesContent).toBe(NOTES_1);
  });

  it('refuses to restore when a referenced blob is missing and leaves the workspace untouched', async () => {
    const abs = path.join(tmp, 'a.txt');
    await fs.writeFile(abs, '磁盘上的新内容', 'utf-8');
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u1', tmp, {
        workspaceFiles: { 'a.txt': SHARED },
        trackedPaths: ['a.txt'],
        uiMessages: [{ role: 'user', id: 'u1', content: '第一句', sentAt: 1 }],
        structuredMessages: [{ role: 'user', content: '第一句' }],
      }),
    });
    await fs.unlink(path.join(intentCheckpointBlobsDir(tmp, sessionId), hashIntentBlobContent(SHARED)));

    await expect(loadIntentCheckpoint(tmp, sessionId, 'u1')).rejects.toBeInstanceOf(IntentCheckpointCorruptError);
    const coordinator = new RuntimeRestoreCoordinator();
    await expect(coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: 'u1',
      defaultWorkDir: tmp,
    })).rejects.toBeInstanceOf(RestoreFailedError);

    expect(await fs.readFile(abs, 'utf-8')).toBe('磁盘上的新内容');
    const index = await loadCheckpointIndex(tmp, sessionId);
    expect(index.entries.map((entry) => entry.messageId)).toEqual(['u1']);
  });

  it('restores an earlier turn from shared blobs and deletes files created later', async () => {
    const user1: UiChatMessage = { role: 'user', id: 'u1', content: '第一句', sentAt: 1 };
    const user2: UiChatMessage = { role: 'user', id: 'u2', content: '第二句', sentAt: 2 };
    const user3: UiChatMessage = { role: 'user', id: 'u3', content: '第三句', sentAt: 3 };
    const agent1: UiChatMessage = { role: 'agent', id: 'a1', content: '好' };
    const structured: UnifiedMessage[] = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '也好' },
      { role: 'user', content: '第三句' },
    ];
    const ui: UiChatMessage[] = [
      user1,
      agent1,
      user2,
      { role: 'agent', id: 'a2', content: '也好' },
      user3,
    ];

    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u1', tmp, {
        userMessageTime: 1,
        workspaceFiles: { 'a.txt': SHARED, 'empty.txt': EMPTY },
        trackedPaths: ['a.txt', 'empty.txt'],
        uiMessages: [user1],
        structuredMessages: structured.slice(0, 1),
        sessionNotesContent: NOTES_1,
        toolTraceDiffsRaw: null,
      }),
    });
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u2', tmp, {
        userMessageTime: 2,
        workspaceFiles: { 'b.txt': null, 'empty.txt': EMPTY },
        trackedPaths: ['b.txt', 'empty.txt'],
        uiMessages: [user1, agent1, user2],
        structuredMessages: structured.slice(0, 3),
        sessionNotesContent: NOTES_2,
        toolTraceDiffsRaw: TRACE_2,
      }),
    });
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive(sessionId, 'u3', tmp, {
        userMessageTime: 3,
        workspaceFiles: {
          'a.txt': SHARED,
          'b.txt': CREATED_B,
          'c.txt': null,
          'empty.txt': EMPTY,
        },
        trackedPaths: ['a.txt', 'b.txt', 'c.txt', 'empty.txt'],
        uiMessages: ui,
        structuredMessages: structured,
        sessionNotesContent: NOTES_3,
        toolTraceDiffsRaw: '{"turn":3}\n',
      }),
    });

    await fs.writeFile(path.join(tmp, 'a.txt'), '磁盘已被改脏', 'utf-8');
    await fs.writeFile(path.join(tmp, 'b.txt'), CREATED_B, 'utf-8');
    await fs.writeFile(path.join(tmp, 'c.txt'), '只在第三回合出现', 'utf-8');
    await fs.writeFile(path.join(tmp, 'empty.txt'), '不是空的', 'utf-8');
    await fs.writeFile(path.join(tmp, `${sessionId}.json`), JSON.stringify(ui), 'utf-8');
    await fs.writeFile(path.join(tmp, `${sessionId}.structured.json`), JSON.stringify(structured), 'utf-8');
    await fs.writeFile(sessionNotesPath(tmp, sessionId), NOTES_3, 'utf-8');
    await fs.writeFile(path.join(tmp, `${sessionId}.tool-trace-diffs.json`), '{"turn":3}\n', 'utf-8');

    const sharedBefore = hashIntentBlobContent(SHARED);
    expect(await blobHashes(tmp, sessionId)).toContain(sharedBefore);

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: 'u2',
      defaultWorkDir: tmp,
    });

    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe(SHARED);
    expect(await fs.readFile(path.join(tmp, 'empty.txt'), 'utf-8')).toBe(EMPTY);
    await expect(fs.access(path.join(tmp, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(tmp, 'c.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(sessionNotesPath(tmp, sessionId), 'utf-8')).toBe(NOTES_2);
    expect(await fs.readFile(path.join(tmp, `${sessionId}.tool-trace-diffs.json`), 'utf-8')).toBe(TRACE_2);

    const restoredUi = JSON.parse(await fs.readFile(path.join(tmp, `${sessionId}.json`), 'utf-8')) as UiChatMessage[];
    expect(restoredUi.map((message) => message.id)).toEqual(['u1', 'a1']);
    const restoredStructured = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.structured.json`), 'utf-8'),
    ) as UnifiedMessage[];
    expect(restoredStructured).toEqual(structured.slice(0, 2));

    const index = await loadCheckpointIndex(tmp, sessionId);
    expect(index.entries.map((entry) => entry.messageId)).toEqual(['u1']);
    expect(await loadIntentCheckpoint(tmp, sessionId, 'u2')).toBeNull();
    expect(await loadIntentCheckpoint(tmp, sessionId, 'u3')).toBeNull();
    const kept = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    expect(kept?.workspaceFiles['a.txt']).toBe(SHARED);
    expect(kept?.sessionNotesContent).toBe(NOTES_1);

    const hashes = await blobHashes(tmp, sessionId);
    expect(hashes).toContain(sharedBefore);
    expect(hashes).not.toContain(hashIntentBlobContent(CREATED_B));
    expect(hashes).not.toContain(hashIntentBlobContent(NOTES_2));
    expect(hashes).not.toContain(hashIntentBlobContent(NOTES_3));
  });

  it('still restores a legacy inline archive and does not rewrite it on load', async () => {
    const messageId = 'u1';
    const inline = {
      version: 1,
      messageId,
      sessionId,
      createdAt: '2026-10-14T00:00:00.000Z',
      userMessageTime: 1,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: tmp,
      workspaceFiles: { 'a.txt': '内联旧内容' },
      trackedPaths: ['a.txt'],
      structuredMessages: [{ role: 'user', content: '旧消息' }],
      uiMessages: [{ role: 'user', id: messageId, content: '旧消息', sentAt: 1 }],
      sessionNotesContent: '旧笔记\n',
      toolTraceDiffsRaw: null,
    };
    const dest = intentCheckpointArchivePath(tmp, sessionId, messageId);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const body = JSON.stringify(inline, null, 2);
    await fs.writeFile(dest, body, 'utf-8');
    await fs.writeFile(
      path.join(tmp, `${sessionId}.checkpoint-index.json`),
      JSON.stringify({
        version: 1,
        cursorMessageId: messageId,
        entries: [{
          messageId,
          archiveFileName: `${messageId}.intent.json`,
          createdAt: inline.createdAt,
          userMessageTime: 1,
        }],
      }),
      'utf-8',
    );
    await fs.writeFile(path.join(tmp, 'a.txt'), '当前内容', 'utf-8');
    await fs.writeFile(
      path.join(tmp, `${sessionId}.json`),
      JSON.stringify([
        { role: 'user', id: messageId, content: '旧消息', sentAt: 1 },
        { role: 'user', id: 'u2', content: '之后', sentAt: 2 },
      ]),
      'utf-8',
    );

    const loaded = await loadIntentCheckpoint(tmp, sessionId, messageId);
    expect(loaded?.workspaceFiles['a.txt']).toBe('内联旧内容');
    expect(await fs.readFile(dest, 'utf-8')).toBe(body);
    await expect(fs.access(intentCheckpointBlobsDir(tmp, sessionId))).rejects.toMatchObject({ code: 'ENOENT' });

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
    });
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('内联旧内容');
    expect(await fs.readFile(sessionNotesPath(tmp, sessionId), 'utf-8')).toBe('旧笔记\n');
  });

  it('shares file bytes across captures and restores the earlier snapshot', async () => {
    const filePath = path.join(tmp, 'src', 'a.txt');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, SHARED, 'utf-8');
    await fs.writeFile(sessionNotesPath(tmp, sessionId), NOTES_1, 'utf-8');

    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: 'u1',
      userMessageTime: 1,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '先读文件' }],
      uiMessages: [{ role: 'user', id: 'u1', content: '先读文件', sentAt: 1 }],
      priorTrackedPaths: ['src/a.txt'],
    });
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: 'u2',
      userMessageTime: 2,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [
        { role: 'user', content: '先读文件' },
        { role: 'assistant', content: '好' },
        { role: 'user', content: '再改文件' },
      ],
      uiMessages: [
        { role: 'user', id: 'u1', content: '先读文件', sentAt: 1 },
        { role: 'agent', id: 'a1', content: '好' },
        { role: 'user', id: 'u2', content: '再改文件', sentAt: 2 },
      ],
      priorTrackedPaths: ['src/a.txt'],
    });

    const raw1 = JSON.parse(await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), 'utf-8'));
    const raw2 = JSON.parse(await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u2'), 'utf-8'));
    expect(raw1.workspaceFileRefs['src/a.txt']).toBe(raw2.workspaceFileRefs['src/a.txt']);
    expect(raw1.workspaceFileRefs['src/a.txt']).toBe(hashIntentBlobContent(SHARED));
    expect(JSON.stringify(raw2)).not.toContain('共享正文');

    await fs.writeFile(filePath, '改过了', 'utf-8');
    await fs.writeFile(path.join(tmp, 'src', 'new.txt'), '新文件', 'utf-8');
    await fs.writeFile(
      path.join(tmp, `${sessionId}.json`),
      JSON.stringify([
        { role: 'user', id: 'u1', content: '先读文件', sentAt: 1 },
        { role: 'agent', id: 'a1', content: '好' },
        { role: 'user', id: 'u2', content: '再改文件', sentAt: 2 },
        {
          role: 'tool_trace',
          toolName: 'write_file',
          detail: 'src/new.txt',
          status: 'success',
          toolCallId: 'call-new',
        },
      ]),
      'utf-8',
    );

    const later = await loadIntentCheckpoint(tmp, sessionId, 'u2');
    expect(later).toBeTruthy();
    const { rewriteIntentCheckpoint } = await import('../../src/harness/intent-checkpoint-store.js');
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...later!,
      workspaceFiles: { ...later!.workspaceFiles, 'src/new.txt': null },
      trackedPaths: [...later!.trackedPaths, 'src/new.txt'],
    });

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: 'u1',
      defaultWorkDir: tmp,
    });

    expect(await fs.readFile(filePath, 'utf-8')).toBe(SHARED);
    await expect(fs.access(path.join(tmp, 'src', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(sessionNotesPath(tmp, sessionId), 'utf-8')).toBe(NOTES_1);
  });
});
