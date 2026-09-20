import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'os';
import { randomUUID } from 'node:crypto';
import {
  classifyUserMemoryDuplicate,
  dedupeUserMemoryDuplicates,
  extractQuotedUserSpeech,
  pickUserDedupKeeper,
} from '../../../src/memory/file-memory/memory-user-dedup.js';
import type { MemoryHeader } from '../../../src/memory/file-memory/types.js';

let tempDir: string;
let evictedDir: string;

function header(overrides: Partial<MemoryHeader> = {}): MemoryHeader {
  return {
    filename: 'user-a.md',
    filePath: '/tmp/user-a.md',
    mtimeMs: Date.now(),
    name: '游戏UI文本必须使用中文',
    description: '用户明确要求所有游戏UI文本使用中文',
    type: 'user',
    level: 'preference',
    evidenceStrength: 'explicit',
    confidence: 0.95,
    recallCount: 10,
    lastRecalledMs: 0,
    createdMs: Date.now(),
    tags: [],
    source: 'llm_extract',
    contentPreview: '',
    eventDateMs: 0,
    ...overrides,
  };
}

async function writeUser(
  filename: string,
  opts: {
    name: string;
    description: string;
    body: string;
    recallCount?: number;
    confidence?: number;
    tags?: string;
    extraFrontmatter?: string;
  },
) {
  const content = `---
name: ${opts.name}
description: ${opts.description}
type: user
memoryCategory: stable_preference
level: preference
evidenceStrength: explicit
confidence: ${opts.confidence ?? 0.95}
tags: ${opts.tags ?? 'dimension:preference'}
createdAt: 2026-07-08T07:22:38.216Z
recallCount: ${opts.recallCount ?? 1}
${opts.extraFrontmatter ?? ''}
---

${opts.body}
`;
  await fs.writeFile(path.join(tempDir, filename), content, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `user-dedup-${randomUUID()}`);
  evictedDir = path.join(tempDir, 'evicted');
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('extractQuotedUserSpeech / classifyUserMemoryDuplicate', () => {
  it('抽出中文原话引号', () => {
    expect(extractQuotedUserSpeech('用户原话：「开始按钮相关的内容都用中文！！！！你写英语谁看得见！」'))
      .toEqual(['开始按钮相关的内容都用中文！！！！你写英语谁看得见！']);
  });

  it('共享原话视为重复，卫生习惯与 ProjectVersion 不合并', () => {
    const quote = '用户原话：「开始按钮相关的内容都用中文！！！！你写英语谁看得见！」';
    const same = classifyUserMemoryDuplicate(
      header({ filename: 'a.md', recallCount: 383 }),
      header({ filename: 'b.md', name: '游戏 UI 文字必须使用中文', recallCount: 292 }),
      quote,
      quote,
    );
    expect(same.duplicate).toBe(true);
    expect(same.reason).toBe('shared_quote');

    const unrelated = classifyUserMemoryDuplicate(
      header({
        filename: 'user_hygiene_cleanup.md',
        name: '代码与任务卫生习惯',
        description: '任务完成后彻底清理临时文件',
      }),
      header({
        filename: 'user-hygiene-cleanup.md',
        name: '禁止修改 Unity ProjectVersion.txt',
        description: '禁止修改 ProjectVersion.txt 中的 Editor 版本号',
      }),
      '零残留：删除 debug-*.mjs',
      '绝对不要修改 ProjectSettings/ProjectVersion.txt',
    );
    expect(unrelated.duplicate).toBe(false);
  });

  it('已整合条目即使召回更低也当 keeper', () => {
    const keeper = header({
      filename: 'user-game-input-immediate-response.md',
      recallCount: 183,
    });
    const loser = header({
      filename: 'user-game-input-responsiveness.md',
      recallCount: 224,
    });
    const picked = pickUserDedupKeeper(
      keeper,
      loser,
      'merged-from: ["user-game-input-immediate-response.md"]\n<!-- Consolidated from user-game-input-immediate-response.md + user-game-input-responsiveness.md -->',
      '用户原话：「楼层加载还是太慢了！按的快就会看不到」',
    );
    expect(picked.keeper.filename).toBe('user-game-input-immediate-response.md');
  });
});

describe('dedupeUserMemoryDuplicates', () => {
  it('合并共享原话的用户条并归档败者', async () => {
    const quote = '用户原话：「开始按钮相关的内容都用中文！！！！你写英语谁看得见！」';
    await writeUser('user-chinese-ui-text.md', {
      name: '游戏UI文本必须使用中文',
      description: '用户明确要求所有游戏UI文本使用中文，拒绝英文',
      body: `${quote}\n规则：面向玩家的 UI 必须中文`,
      recallCount: 383,
    });
    await writeUser('user-game-ui-must-be-chinese.md', {
      name: '游戏 UI 文字必须使用中文',
      description: '用户明确要求所有游戏内 UI 文字必须使用中文',
      body: `${quote}\n注意：编程变量名仍用英文`,
      recallCount: 292,
    });
    await writeUser('user-hygiene-cleanup.md', {
      name: '禁止修改 Unity ProjectVersion.txt',
      description: '用户明确禁止修改 ProjectVersion.txt 中的 Editor 版本号',
      body: '绝对不要修改 ProjectSettings/ProjectVersion.txt',
      recallCount: 404,
    });

    const first = await dedupeUserMemoryDuplicates(tempDir, evictedDir);
    expect(first.merged).toHaveLength(1);
    expect(first.merged[0].keeper).toBe('user-chinese-ui-text.md');
    expect(first.merged[0].loser).toBe('user-game-ui-must-be-chinese.md');
    expect(first.archived).toEqual(['user-game-ui-must-be-chinese.md']);

    await expect(fs.access(path.join(tempDir, 'user-game-ui-must-be-chinese.md'))).rejects.toThrow();
    await expect(fs.access(path.join(evictedDir, 'user-game-ui-must-be-chinese.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempDir, 'user-hygiene-cleanup.md'))).resolves.toBeUndefined();

    const keeper = await fs.readFile(path.join(tempDir, 'user-chinese-ui-text.md'), 'utf-8');
    expect(keeper).toContain('merged-from:');
    expect(keeper).toContain('user-game-ui-must-be-chinese.md');
    expect(keeper).toContain('编程变量名仍用英文');

    const second = await dedupeUserMemoryDuplicates(tempDir, evictedDir);
    expect(second.merged).toHaveLength(0);
  });

  it('共享 preference 标签的输入响应条会合并', async () => {
    await writeUser('user-game-input-immediate-response.md', {
      name: '游戏输入必须立即响应',
      description: '禁止输入缓冲，快速操作时前方内容必须充足',
      body: '禁止输入缓冲\n<!-- Consolidated from user-game-input-immediate-response.md + user-game-input-responsiveness.md -->',
      recallCount: 183,
      tags: 'preference:input-responsiveness, platform:unity',
    });
    await writeUser('user-game-input-responsiveness.md', {
      name: '用户对游戏响应速度的极致要求',
      description: '输入必须立即响应，前方楼梯必须充足可见',
      body: '用户原话：「楼层加载还是太慢了！按的快就会看不到」',
      recallCount: 224,
      tags: 'preference:input-responsiveness, platform:unity',
    });

    const result = await dedupeUserMemoryDuplicates(tempDir, evictedDir);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].keeper).toBe('user-game-input-immediate-response.md');
    expect(result.merged[0].reason).toBe('shared_preference_tag');
  });
});
