import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeIntentBlobFile } from '../../src/harness/intent-checkpoint-blob-io.js';
import { runIntentCheckpointMaintenance } from '../../src/harness/intent-checkpoint-maintenance.js';
import {
  hashIntentBlobContent,
  intentCheckpointBlobsDir,
  IntentCheckpointCorruptError,
} from '../../src/harness/intent-checkpoint-blobs.js';
import {
  intentCheckpointArchivePath,
  loadIntentCheckpoint,
  loadIntentCheckpointHead,
  mergeIntentCheckpointWorkspaceFiles,
  migrateIntentCheckpointStorage,
  rewriteIntentCheckpoint,
  saveIntentCheckpoint,
  sweepIntentCheckpointBlobs,
  updateIntentCheckpointConversation,
} from '../../src/harness/intent-checkpoint-store.js';
import type { IntentCheckpointArchive, UiChatMessage } from '../../src/types/intent-checkpoint.js';
import type { ProjectCheckpointV3 } from '../../src/types/runtime-checkpoint.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

const sessionId = 'sess-v2';
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-intent-v2-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function archive(
  messageId: string,
  fields: Partial<IntentCheckpointArchive> & Pick<IntentCheckpointArchive, 'workspaceFiles' | 'trackedPaths'>,
): IntentCheckpointArchive {
  return {
    version: 1,
    messageId,
    sessionId,
    createdAt: '2026-10-14T00:00:00.000Z',
    userMessageTime: 1,
    workspace: { referenceReads: [], changeCount: 0 },
    workspaceRoot: tmp,
    structuredMessages: [],
    uiMessages: [],
    ...fields,
  };
}

function projectCheckpoint(messages: UnifiedMessage[]): ProjectCheckpointV3 {
  return {
    version: 3,
    identity: { checkpointId: 'cp-1', projectId: 'project-1', sessionId },
    execution: {
      taskState: {
        goal: 'keep messages shared',
        intent: 'edit',
        phase: 'editing',
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
      },
      loopState: {
        currentRound: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        totalToolCalls: 0,
        startTime: 1,
      },
    },
    completion: { conditions: [], operationOutcomes: [] },
    conversation: { messages },
    workspace: {
      root: tmp,
      repoContext: {
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
    },
    memory: { sessionNotes: '笔记' },
    snapshotMeta: { capturedAt: '2026-10-14T00:00:00.000Z', trigger: 'manual' },
    extensions: {},
    migration: null,
  };
}

async function readRaw(messageId: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, messageId), 'utf-8'));
}

function blobPath(hash: string): string {
  return path.join(intentCheckpointBlobsDir(tmp, sessionId), hash);
}

async function blobNames(): Promise<string[]> {
  const names = await fs.readdir(intentCheckpointBlobsDir(tmp, sessionId)).catch(() => [] as string[]);
  return names.filter((name) => /^[a-f0-9]{64}$/.test(name));
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

async function writeIndex(messageIds: string[]): Promise<void> {
  await fs.writeFile(
    path.join(tmp, `${sessionId}.checkpoint-index.json`),
    JSON.stringify({
      version: 1,
      cursorMessageId: messageIds[messageIds.length - 1] ?? null,
      entries: messageIds.map((messageId, i) => ({
        messageId,
        archiveFileName: `${messageId}.intent.json`,
        createdAt: '2026-10-14T00:00:00.000Z',
        userMessageTime: i + 1,
      })),
    }),
    'utf-8',
  );
}

describe('intent checkpoint blobs-v2', () => {
  it('compresses large blobs on disk and still reads old uncompressed blobs', async () => {
    const body = '这一行会重复很多次 / repeated line\n'.repeat(400);
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', { workspaceFiles: { 'a.txt': body }, trackedPaths: ['a.txt'] }),
    });

    const onDisk = await fs.readFile(blobPath(hashIntentBlobContent(body)));
    expect([...onDisk.subarray(0, 4)]).toEqual([0xff, 0x69, 0x63, 0x01]);
    expect(onDisk.length).toBeLessThan(Buffer.byteLength(body) / 4);
    expect(await decodeIntentBlobFile(onDisk)).toBe(body);
    expect((await loadIntentCheckpoint(tmp, sessionId, 'u1'))?.workspaceFiles['a.txt']).toBe(body);

    const legacyBody = '旧版未压缩的正文\n'.repeat(200);
    const legacyHash = hashIntentBlobContent(legacyBody);
    await fs.writeFile(blobPath(legacyHash), legacyBody, 'utf-8');
    await fs.writeFile(intentCheckpointArchivePath(tmp, sessionId, 'u0'), JSON.stringify({
      version: 1,
      storage: 'blobs-v1',
      messageId: 'u0',
      sessionId,
      createdAt: '2026-10-14T00:00:00.000Z',
      userMessageTime: 0,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: tmp,
      workspaceFileRefs: { 'old.txt': legacyHash },
      trackedPaths: ['old.txt'],
      structuredMessageRefs: [],
      uiMessageRefs: [],
    }), 'utf-8');
    expect((await loadIntentCheckpoint(tmp, sessionId, 'u0'))?.workspaceFiles['old.txt']).toBe(legacyBody);
  });

  it('stores a long string inside a message once across checkpoints', async () => {
    const image = `data:image/png;base64,${'QUJD'.repeat(10_000)}`;
    const first: UnifiedMessage = { role: 'user', content: image };
    const second: UnifiedMessage = { role: 'user', content: '再看一次' };
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', { workspaceFiles: {}, trackedPaths: [], structuredMessages: [first] }),
    });
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u2', { workspaceFiles: {}, trackedPaths: [], structuredMessages: [first, second] }),
    });

    const raw1 = await readRaw('u1');
    const raw2 = await readRaw('u2');
    expect(raw1.structuredMessageRefs[0]).toEqual(raw2.structuredMessageRefs[0]);
    expect(raw1.structuredMessageRefs[0].h).toEqual([[['content'], hashIntentBlobContent(image)]]);

    let copies = 0;
    for (const name of await blobNames()) {
      if ((await decodeIntentBlobFile(await fs.readFile(blobPath(name)))).includes('QUJDQUJD')) copies++;
    }
    expect(copies).toBe(1);
    expect((await loadIntentCheckpoint(tmp, sessionId, 'u2'))?.structuredMessages).toEqual([first, second]);
  });

  it('keeps projectCheckpoint messages as references shared with structuredMessages', async () => {
    const structured: UnifiedMessage[] = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '回答'.repeat(200) },
    ];
    const pc = projectCheckpoint(structured);
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', {
        workspaceFiles: {},
        trackedPaths: [],
        structuredMessages: structured,
        projectCheckpoint: pc,
      }),
    });

    const raw = await readRaw('u1');
    expect(raw.projectCheckpointRef.m).toEqual(raw.structuredMessageRefs);
    const pcBody = await decodeIntentBlobFile(await fs.readFile(blobPath(raw.projectCheckpointRef.b)));
    expect(pcBody).not.toContain('回答');
    const loaded = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    expect(loaded?.projectCheckpoint).toEqual(pc);
  });

  it('round-trips paths that do not fit a directory tree', async () => {
    const files = JSON.parse(`{
      "src/a.ts": "A",
      "src/deep/b.ts": "B",
      "../outside.txt": "O",
      "a//b.txt": null,
      "./dot.txt": "D",
      "__proto__": "P",
      "dir/constructor": "C"
    }`) as Record<string, string | null>;
    expect(Object.hasOwn(files, '__proto__')).toBe(true);
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', { workspaceFiles: files, trackedPaths: ['src/a.ts', 'only-tracked.txt'] }),
    });

    const raw = await readRaw('u1');
    expect(Object.keys(raw.looseFileRefs).sort()).toEqual(['../outside.txt', './dot.txt', 'a//b.txt']);
    expect(raw.trackedPathsExtra).toEqual(['only-tracked.txt']);
    const loaded = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    expect(loaded?.workspaceFiles).toEqual(files);
    expect(Object.hasOwn(loaded!.workspaceFiles, '__proto__')).toBe(true);
    expect([...loaded!.trackedPaths].sort()).toEqual(['only-tracked.txt', 'src/a.ts']);
  });

  it('merges turn snapshots into the file list without rewriting messages', async () => {
    const ui: UiChatMessage[] = [{ role: 'user', id: 'u1', content: '改文件', sentAt: 1 }];
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', {
        workspaceFiles: { 'a.txt': 'v1' },
        trackedPaths: ['a.txt'],
        uiMessages: ui,
        structuredMessages: [{ role: 'user', content: '改文件' }],
        projectCheckpoint: projectCheckpoint([{ role: 'user', content: '改文件' }]),
        sessionNotesContent: '笔记',
      }),
    });
    const before = await readRaw('u1');

    expect(await mergeIntentCheckpointWorkspaceFiles(tmp, sessionId, 'u1', {
      'a.txt': '本轮写之前已被改过',
      'b.txt': null,
      'c.txt': 'new',
    })).toBe(true);
    expect(await mergeIntentCheckpointWorkspaceFiles(tmp, sessionId, 'missing', { 'x.txt': null })).toBe(false);

    const after = await readRaw('u1');
    expect(after.workspaceTreeRef).not.toBe(before.workspaceTreeRef);
    for (const key of ['uiMessageRefs', 'structuredMessageRefs', 'projectCheckpointRef', 'sessionNotesRef']) {
      expect(after[key]).toEqual(before[key]);
    }
    const loaded = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    expect(loaded?.workspaceFiles).toEqual({ 'a.txt': 'v1', 'b.txt': null, 'c.txt': 'new' });
    expect([...loaded!.trackedPaths].sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('rewrites only the conversation and skips the write when nothing changes', async () => {
    const ui: UiChatMessage[] = [
      { role: 'user', id: 'u0', content: '要删掉的', sentAt: 1 },
      { role: 'user', id: 'u1', content: '留下', sentAt: 2 },
    ];
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', { workspaceFiles: { 'a.txt': 'A' }, trackedPaths: ['a.txt'], uiMessages: ui }),
    });
    const beforeText = await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), 'utf-8');

    expect(await updateIntentCheckpointConversation(tmp, sessionId, 'u1', () => null)).toBe(false);
    expect(await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), 'utf-8')).toBe(beforeText);

    expect(await updateIntentCheckpointConversation(tmp, sessionId, 'u1', ({ uiMessages, structuredMessages }) => ({
      uiMessages: uiMessages.filter((m) => m.id !== 'u0'),
      structuredMessages,
    }))).toBe(true);
    const after = await readRaw('u1');
    expect(after.workspaceTreeRef).toBe(JSON.parse(beforeText).workspaceTreeRef);
    expect((await loadIntentCheckpoint(tmp, sessionId, 'u1'))?.uiMessages.map((m) => m.id)).toEqual(['u1']);
  });

  it('collects orphan blobs only when a write can orphan them', async () => {
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', { workspaceFiles: { 'a.txt': 'A' }, trackedPaths: ['a.txt'] }),
    });
    const orphan = hashIntentBlobContent('没人引用');
    await fs.writeFile(blobPath(orphan), '没人引用', 'utf-8');

    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u2', { workspaceFiles: { 'a.txt': 'A2' }, trackedPaths: ['a.txt'] }),
    });
    expect(await exists(blobPath(orphan))).toBe(true);

    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u2', { workspaceFiles: { 'a.txt': 'A3' }, trackedPaths: ['a.txt'] }),
    });
    expect(await exists(blobPath(orphan))).toBe(false);
    expect(await exists(blobPath(hashIntentBlobContent('A2')))).toBe(false);
    expect((await loadIntentCheckpoint(tmp, sessionId, 'u1'))?.workspaceFiles['a.txt']).toBe('A');
  });

  it('refuses to collect blobs while a directory tree is unreadable', async () => {
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('u1', { workspaceFiles: { 'src/a.txt': 'A' }, trackedPaths: ['src/a.txt'] }),
    });
    const raw = await readRaw('u1');
    await fs.writeFile(blobPath(raw.workspaceTreeRef), '{"t":1,"e":"broken"}', 'utf-8');
    const orphan = hashIntentBlobContent('孤儿');
    await fs.writeFile(blobPath(orphan), '孤儿', 'utf-8');

    await sweepIntentCheckpointBlobs(tmp, sessionId);
    expect(await exists(blobPath(orphan))).toBe(true);
    expect(await exists(blobPath(hashIntentBlobContent('A')))).toBe(true);
    await expect(loadIntentCheckpointHead(tmp, sessionId, 'u1'))
      .rejects.toBeInstanceOf(IntentCheckpointCorruptError);
  });

  it('migrates inline and blobs-v1 archives without changing their content', async () => {
    const shared = '共享正文\n'.repeat(50);
    const ui: UiChatMessage[] = [{ role: 'user', id: 'u1', content: '旧消息', sentAt: 1 }];
    const structured: UnifiedMessage[] = [{ role: 'user', content: '旧消息' }];
    const pc = projectCheckpoint(structured);
    const checkpointsDir = path.dirname(intentCheckpointArchivePath(tmp, sessionId, 'u1'));
    await fs.mkdir(intentCheckpointBlobsDir(tmp, sessionId), { recursive: true });

    await fs.writeFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), JSON.stringify({
      version: 1,
      messageId: 'u1',
      sessionId,
      createdAt: '2026-10-14T00:00:00.000Z',
      userMessageTime: 1,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: tmp,
      workspaceFiles: { 'a.txt': shared, 'gone.txt': null },
      trackedPaths: ['a.txt', 'gone.txt'],
      structuredMessages: structured,
      uiMessages: ui,
      sessionNotesContent: '旧笔记',
      toolTraceDiffsRaw: null,
    }), 'utf-8');

    const v1Blobs = new Map<string, string>();
    const put = (text: string) => {
      const hash = hashIntentBlobContent(text);
      v1Blobs.set(hash, text);
      return hash;
    };
    const pcHash = put(JSON.stringify(pc));
    const v1Head = {
      version: 1,
      storage: 'blobs-v1',
      messageId: 'u2',
      sessionId,
      createdAt: '2026-10-14T00:00:00.000Z',
      userMessageTime: 2,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: tmp,
      workspaceFileRefs: { 'a.txt': put(shared), 'src/b.txt': put('B') },
      trackedPaths: ['a.txt', 'src/b.txt'],
      structuredMessageRefs: structured.map((m) => put(JSON.stringify(m))),
      uiMessageRefs: ui.map((m) => put(JSON.stringify(m))),
      projectCheckpointRef: pcHash,
      sessionNotesRef: put('v1 笔记'),
      toolTraceDiffsRef: null,
    };
    for (const [hash, text] of v1Blobs) await fs.writeFile(blobPath(hash), text, 'utf-8');
    await fs.writeFile(path.join(checkpointsDir, 'u2.intent.json'), JSON.stringify(v1Head), 'utf-8');
    await writeIndex(['u1', 'u2']);

    const before1 = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    const before2 = await loadIntentCheckpoint(tmp, sessionId, 'u2');

    expect(await migrateIntentCheckpointStorage(tmp, sessionId)).toEqual({ converted: 2, failed: 0 });
    expect((await readRaw('u1')).storage).toBe('blobs-v2');
    expect((await readRaw('u2')).storage).toBe('blobs-v2');
    expect(await loadIntentCheckpoint(tmp, sessionId, 'u1')).toEqual(before1);
    expect(await loadIntentCheckpoint(tmp, sessionId, 'u2')).toEqual(before2);
    expect(await exists(blobPath(pcHash))).toBe(false);

    expect(await migrateIntentCheckpointStorage(tmp, sessionId)).toEqual({ converted: 0, failed: 0 });
  });

  it('maintenance converts old archives and compresses inherited blobs once', async () => {
    const body = '旧版留下的未压缩正文，内容足够长也足够重复。\n'.repeat(100);
    const hash = hashIntentBlobContent(body);
    await fs.mkdir(intentCheckpointBlobsDir(tmp, sessionId), { recursive: true });
    await fs.writeFile(blobPath(hash), body, 'utf-8');
    await fs.writeFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), JSON.stringify({
      version: 1,
      storage: 'blobs-v1',
      messageId: 'u1',
      sessionId,
      createdAt: '2026-10-14T00:00:00.000Z',
      userMessageTime: 1,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: tmp,
      workspaceFileRefs: { 'a.txt': hash },
      trackedPaths: ['a.txt'],
      structuredMessageRefs: [],
      uiMessageRefs: [],
    }), 'utf-8');
    await writeIndex(['u1']);

    const first = await runIntentCheckpointMaintenance(tmp);
    expect(first).toMatchObject({ sessions: 1, converted: 1, failed: 0 });
    expect(first.savedBytes).toBeGreaterThan(0);
    expect([...(await fs.readFile(blobPath(hash))).subarray(0, 4)]).toEqual([0xff, 0x69, 0x63, 0x01]);
    expect((await loadIntentCheckpoint(tmp, sessionId, 'u1'))?.workspaceFiles['a.txt']).toBe(body);

    expect(await runIntentCheckpointMaintenance(tmp)).toEqual({
      sessions: 1,
      converted: 0,
      failed: 0,
      savedBytes: 0,
    });
  });

  it('upgrades an old archive when it is rewritten', async () => {
    await fs.mkdir(path.dirname(intentCheckpointArchivePath(tmp, sessionId, 'u1')), { recursive: true });
    await fs.writeFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), JSON.stringify(
      archive('u1', { workspaceFiles: { 'a.txt': 'A' }, trackedPaths: ['a.txt'] }),
    ), 'utf-8');
    await writeIndex(['u1']);
    const loaded = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    await rewriteIntentCheckpoint(tmp, sessionId, { ...loaded!, trackedPaths: ['a.txt', 'b.txt'] });

    expect((await readRaw('u1')).storage).toBe('blobs-v2');
    const head = await loadIntentCheckpointHead(tmp, sessionId, 'u1');
    expect(head?.files).toEqual({ 'a.txt': { hash: hashIntentBlobContent('A') } });
    expect([...head!.trackedPaths].sort()).toEqual(['a.txt', 'b.txt']);
  });
});
