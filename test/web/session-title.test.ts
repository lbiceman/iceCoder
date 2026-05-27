/**
 * 会话标题：首条提示词截取与占位回填
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('session-title', () => {
  let tempDir: string;
  const prevSessionsDir = process.env.ICE_SESSIONS_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-title-'));
    process.env.ICE_SESSIONS_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (prevSessionsDir === undefined) {
      delete process.env.ICE_SESSIONS_DIR;
    } else {
      process.env.ICE_SESSIONS_DIR = prevSessionsDir;
    }
  });

  it('deriveSessionTitleFromPrompt truncates long text', async () => {
    const { deriveSessionTitleFromPrompt, SESSION_TITLE_MAX_LEN } = await import(
      '../../src/web/session-title.js'
    );
    const long = '使用git diff分析刚才的变动并给出建议';
    const title = deriveSessionTitleFromPrompt(long);
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_LEN);
    expect(title.endsWith('…')).toBe(true);
    expect(title.startsWith('使用git diff')).toBe(true);
  });

  it('applyFirstPromptSessionTitle updates placeholder on first user message', async () => {
    const sessionId = 'abc12345';
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        {
          id: sessionId,
          title: '新会话',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 0,
        },
      ]),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, `${sessionId}.json`),
      JSON.stringify([{ role: 'user', content: '帮我写单元测试', id: 'u1' }]),
      'utf-8',
    );

    const { applyFirstPromptSessionTitle } = await import('../../src/web/session-title.js');
    const title = await applyFirstPromptSessionTitle(sessionId, '帮我写单元测试');
    expect(title).toBe('帮我写单元测试');

    const index = JSON.parse(await fs.readFile(path.join(tempDir, 'index.json'), 'utf-8')) as {
      title: string;
    }[];
    expect(index[0].title).toBe('帮我写单元测试');
  });

  it('applyFirstPromptSessionTitle skips when user renamed', async () => {
    const sessionId = 'xyz99999';
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        {
          id: sessionId,
          title: '我的专项',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 0,
        },
      ]),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, `${sessionId}.json`),
      JSON.stringify([{ role: 'user', content: 'hello', id: 'u1' }]),
      'utf-8',
    );

    const { applyFirstPromptSessionTitle } = await import('../../src/web/session-title.js');
    const title = await applyFirstPromptSessionTitle(sessionId, 'hello');
    expect(title).toBeNull();
  });

  it('backfillPlaceholderSessionTitles fills from persisted messages', async () => {
    const sessionId = 'default';
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        {
          id: sessionId,
          title: '默认会话',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 0,
        },
      ]),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, `${sessionId}.json`),
      JSON.stringify([{ role: 'user', content: '审计多会话实现' }]),
      'utf-8',
    );

    const { backfillPlaceholderSessionTitles } = await import('../../src/web/session-title.js');
    const index = await backfillPlaceholderSessionTitles([
      {
        id: sessionId,
        title: '默认会话',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      },
    ]);
    expect(index[0].title).toBe('审计多会话实现');
  });
});
