import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { addSessionReferenceReads } from '../../src/harness/session-workspace-store.js';
import { checkWorkspacePathViolation } from '../../src/harness/workspace-path-guard.js';
import {
  buildSessionImageApiUrl,
  persistInlineImages,
  resolveSessionImageFile,
} from '../../src/web/images-cache.js';

describe('session imagesCache workspace + UI', () => {
  let sessionDir: string;
  let sessionId: string;
  const prevSessions = process.env.ICE_SESSIONS_DIR;
  const prevNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-img-ws-'));
    sessionId = 'sess-img-1';
    process.env.ICE_SESSIONS_DIR = sessionDir;
    process.env.NODE_ENV = 'development';
  });

  afterEach(async () => {
    if (prevSessions === undefined) delete process.env.ICE_SESSIONS_DIR;
    else process.env.ICE_SESSIONS_DIR = prevSessions;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  });

  it('addSessionReferenceReads 登记 imagesCache 路径供 image_read 通过 workspace guard', async () => {
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const saved = await persistInlineImages([`data:image/png;base64,${png1x1}`], sessionId);
    expect(saved).toHaveLength(1);

    const state = await addSessionReferenceReads({
      sessionDir,
      sessionId,
      paths: [saved[0].absolutePath],
    });
    expect(state.referenceReads.some((r) => r.toLowerCase() === saved[0].absolutePath.toLowerCase())).toBe(true);

    const violation = checkWorkspacePathViolation(
      'image_read',
      { path: saved[0].absolutePath },
      'E:\\other\\workspace',
      state.referenceReads,
    );
    expect(violation).toBeUndefined();
  });

  it('resolveSessionImageFile 拒绝目录穿越', () => {
    expect(resolveSessionImageFile(sessionId, '../secret.png')).toBeUndefined();
    expect(resolveSessionImageFile(sessionId, 'ok.png')).toContain('ok.png');
  });

  it('buildSessionImageApiUrl 生成 REST 路径', () => {
    expect(buildSessionImageApiUrl('abc', 'D:\\data\\imagesCache\\abc\\x.png')).toBe(
      '/api/sessions/abc/images/x.png',
    );
  });
});
