import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUserRulesRouter } from '../../../src/web/routes/user-rules.js';
import { UserRulesStore } from '../../../src/prompts/user-rules-store.js';
import { USER_RULES_LIMITS } from '../../../src/prompts/user-rules.js';

describe('user rules router', () => {
  let dir: string;
  let server: Server;
  let base: string;

  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-user-rules-route-'));
    const app = express();
    app.use(express.json());
    app.use('/api/user-rules', createUserRulesRouter(new UserRulesStore(path.join(dir, 'user-rules.json'))));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('GET 空列表返回限额与 0 token', async () => {
    const res = await call('GET', '/api/user-rules');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      rules: [],
      limits: USER_RULES_LIMITS,
      enabledChars: 0,
      estimatedTokens: 0,
    });
    expect(res.body.overheadTokens).toBeGreaterThan(0);
  });

  it('增 / 改 / 停用 / 删，并同步返回最新汇总', async () => {
    const created = await call('POST', '/api/user-rules', { content: '始终使用简体中文回复' });
    expect(created.status).toBe(200);
    const id = created.body.rule.id;
    expect(created.body.enabledChars).toBe(10);
    expect(created.body.estimatedTokens).toBeGreaterThan(created.body.overheadTokens);

    const edited = await call('PUT', `/api/user-rules/${id}`, { content: '用中文' });
    expect(edited.body.rule.content).toBe('用中文');
    expect(edited.body.enabledChars).toBe(3);

    const disabled = await call('PUT', `/api/user-rules/${id}`, { enabled: false });
    expect(disabled.body.rule.enabled).toBe(false);
    expect(disabled.body.estimatedTokens).toBe(0);

    const removed = await call('DELETE', `/api/user-rules/${id}`);
    expect(removed.body).toMatchObject({ success: true, rules: [] });
  });

  it('校验失败返回 400 与中文原因', async () => {
    const empty = await call('POST', '/api/user-rules', { content: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain('不能为空');

    const tooLong = await call('POST', '/api/user-rules', { content: 'x'.repeat(USER_RULES_LIMITS.maxEnabledTotalChars + 1) });
    expect(tooLong.status).toBe(400);

    const secret = await call('POST', '/api/user-rules', { content: `token ghp_${'a'.repeat(36)}` });
    expect(secret.status).toBe(400);
    expect(secret.body.error).toContain('敏感信息');

    expect((await call('GET', '/api/user-rules')).body.rules).toEqual([]);
  });

  it('不存在的规则返回 404', async () => {
    expect((await call('PUT', '/api/user-rules/missing', { enabled: true })).status).toBe(404);
    expect((await call('DELETE', '/api/user-rules/missing')).status).toBe(404);
  });
});
