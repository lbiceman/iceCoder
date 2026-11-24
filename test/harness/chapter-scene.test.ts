import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSceneDiff,
  composeChapterFiles,
  diffFileRefs,
  isTestCommand,
  pickTestVerdict,
  tracesForChapter,
  type SceneTrace,
} from '../../src/harness/chapter-scene.js';
import { readChapterScene, readChapterSceneDiff, readChapterScenes } from '../../src/harness/chapter-scene-read.js';
import { saveIntentCheckpoint } from '../../src/harness/intent-checkpoint-store.js';
import { writeUiSessionMessages } from '../../src/harness/intent-checkpoint-capture.js';
import type { IntentCheckpointArchive } from '../../src/types/intent-checkpoint.js';

const sessionId = 'scene-sess';
let tmp: string;

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

function archive(
  messageId: string,
  userMessageTime: number,
  workspaceFiles: Record<string, string | null>,
): IntentCheckpointArchive {
  return {
    version: 1,
    messageId,
    sessionId,
    createdAt: '2026-11-23T00:00:00.000Z',
    userMessageTime,
    workspace: { referenceReads: [], changeCount: 0 },
    workspaceRoot: tmp,
    workspaceFiles,
    trackedPaths: Object.keys(workspaceFiles),
    structuredMessages: [],
    uiMessages: [],
  };
}

describe('diffFileRefs', () => {
  it('只列出哈希变化、新增和明确删除，相同哈希跳过', () => {
    const changes = diffFileRefs(
      {
        'src/a.ts': 'hash-a',
        'src/keep.ts': 'hash-k',
        'src/gone.ts': 'hash-g',
        'src/missing-later.ts': 'hash-m',
        'src/was-empty.ts': null,
      },
      {
        'src/a.ts': 'hash-a2',
        'src/keep.ts': 'hash-k',
        'src/gone.ts': null,
        'src/was-empty.ts': 'hash-new',
        'src/fresh.ts': 'hash-f',
      },
    );
    expect(changes).toEqual([
      { path: 'src/a.ts', op: 'modified' },
      { path: 'src/fresh.ts', op: 'added' },
      { path: 'src/gone.ts', op: 'deleted' },
      { path: 'src/was-empty.ts', op: 'added' },
    ]);
  });
});

describe('composeChapterFiles', () => {
  const traces: SceneTrace[] = [
    { toolName: 'edit_file', detail: 'src/a.ts', status: 'done', toolCallId: 'e1', diffSource: '' },
    { toolName: 'read_file', detail: 'src/read.ts', status: 'done', toolCallId: 'r1', diffSource: '' },
    { toolName: 'write_file', detail: 'src/new.ts', status: 'done', toolCallId: 'w1', diffSource: '' },
    { toolName: 'run_command', detail: 'npm test', status: 'done', toolCallId: 'c1', diffSource: '' },
  ];

  it('新读进跟踪名单的文件不算这一章的改动，命令新建的算', () => {
    const files = composeChapterFiles([
      { path: 'src/a.ts', op: 'modified' },
      { path: 'src/read.ts', op: 'added' },
      { path: 'src/new.ts', op: 'added' },
      { path: 'src/out.txt', op: 'added' },
    ], traces);
    expect(files.map((file) => [file.path, file.op])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/new.ts', 'added'],
      ['src/out.txt', 'command'],
    ]);
  });

  it('最后一条测试命令决定结果，安装命令不算', () => {
    expect(isTestCommand('npm install')).toBe(false);
    expect(isTestCommand('npm test')).toBe(true);
    expect(pickTestVerdict([
      { toolName: 'run_command', detail: 'npm install', status: 'done', toolCallId: 'i', diffSource: '' },
      { toolName: 'run_command', detail: 'npm test', status: 'done', toolCallId: 't', diffSource: '' },
      { toolName: 'run_command', detail: 'pytest -q', status: 'failed', toolCallId: 'p', diffSource: '' },
    ])).toBe('failed');
  });
});

describe('buildSceneDiff', () => {
  it('只写出变化的行', () => {
    const diff = buildSceneDiff('keep\nold\n', 'keep\nnew\n', 'src/a.ts', 'modified');
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.diff).toContain('-old');
    expect(diff.diff).toContain('+new');
    expect(diff.binary).toBe(false);
  });

  it('二进制不展开正文', () => {
    const diff = buildSceneDiff('a\0b', 'a\0c', 'a.bin', 'modified');
    expect(diff.binary).toBe(true);
    expect(diff.diff).toBe('');
  });
});

describe('readChapterScenes', () => {
  it('用相邻检查点的内容哈希装出现场，不改检查点文件', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-chapter-scene-'));
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('m1', 1, {
        'src/a.ts': 'one\n',
        'src/keep.ts': 'k\n',
        'src/gone.ts': 'x\n',
      }),
    });
    await saveIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      archive: archive('m2', 2, {
        'src/a.ts': 'two\n',
        'src/keep.ts': 'k\n',
        'src/gone.ts': null,
        'src/new.ts': 'n\n',
        'src/read.ts': 'r\n',
        'src/out.txt': 'o\n',
      }),
    });
    await writeUiSessionMessages(tmp, sessionId, [
      { role: 'user', id: 'm1', content: '改一下' },
      { role: 'tool_trace', toolName: 'edit_file', detail: 'src/a.ts', status: 'done', toolCallId: 'e1' },
      { role: 'tool_trace', toolName: 'read_file', detail: 'src/read.ts', status: 'done', toolCallId: 'r1' },
      { role: 'tool_trace', toolName: 'write_file', detail: 'src/new.ts', status: 'done', toolCallId: 'w1' },
      { role: 'tool_trace', toolName: 'run_command', detail: 'npm test', status: 'done', toolCallId: 'c1' },
      { role: 'user', id: 'm2', content: '下一句' },
    ]);

    const before = await fs.readFile(path.join(tmp, sessionId, 'checkpoints', 'm1.intent.json'), 'utf-8');
    const scenes = await readChapterScenes(tmp, sessionId);
    const after = await fs.readFile(path.join(tmp, sessionId, 'checkpoints', 'm1.intent.json'), 'utf-8');
    expect(after).toBe(before);

    expect(scenes.map((scene) => [scene.messageId, scene.sealed, scene.fileCount, scene.test])).toEqual([
      ['m1', true, 4, 'passed'],
      ['m2', false, 0, 'none'],
    ]);

    const detail = await readChapterScene(tmp, sessionId, 'm1');
    expect(detail?.files.map((file) => [file.path, file.op])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/gone.ts', 'deleted'],
      ['src/new.ts', 'added'],
      ['src/out.txt', 'command'],
    ]);

    const diff = await readChapterSceneDiff(tmp, sessionId, 'm1', 'src/a.ts');
    expect(diff?.diff).toContain('-one');
    expect(diff?.diff).toContain('+two');
    expect(tracesForChapter([], 'm1', null)).toEqual([]);
  });
});
