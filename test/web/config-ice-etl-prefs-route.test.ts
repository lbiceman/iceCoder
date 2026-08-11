import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, startServer } from '../../src/web/server.js';
import { createConfigRouter } from '../../src/web/routes/config.js';
import { DEFAULT_ICE_ETL_PREFS } from '../../src/config/main-config-ice-etl-prefs.js';
import type { Server } from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

/**
 * PATCH /api/config/ice-etl-prefs 路由测试。
 * 锁第三份清单：allowedKeys 必须与 DEFAULT_ICE_ETL_PREFS 键完全一致——
 * 所有 DEFAULT 键均被接受，任何额外键被拒绝。
 */
describe('PATCH /api/config/ice-etl-prefs（allowedKeys 与 DEFAULT 一致性）', () => {
  let server: Server | null = null;
  let tempDir: string;
  let configPath: string;
  let setupRequired = true;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'etl-route-'));
    configPath = path.join(tempDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ providers: [] }, null, 2));
    setupRequired = true;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function startTestServer(): Promise<number> {
    const app = await createServer({
      setupGate: () => setupRequired,
      routes: [{
        path: '/api/config',
        router: createConfigRouter({ configPath }),
      }],
    });
    server = await startServer(app, 0);
    return getPort(server);
  }

  async function patchIceEtlPrefs(port: number, patch: unknown) {
    return fetch(`http://127.0.0.1:${port}/api/config/ice-etl-prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iceEtlPrefs: patch }),
    });
  }

  it('DEFAULT_ICE_ETL_PREFS 的每个键都能被接受（locked allowedKeys ⊇ DEFAULT）', async () => {
    const port = await startTestServer();
    const cases: Record<string, unknown> = {
      showTransparencyPanel: false,
      panelDefaultExpanded: false,
      panelWidth: 420,
      taskDoneNotification: true,
      panelAutoCollapse: true,
    };
    for (const key of Object.keys(DEFAULT_ICE_ETL_PREFS)) {
      const res = await patchIceEtlPrefs(port, { [key]: cases[key] });
      expect(res.status, `键 ${key} 应被接受`).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    }
  });

  it('未知字段被拒绝（allowedKeys ⊆ DEFAULT）', async () => {
    const port = await startTestServer();
    const res = await patchIceEtlPrefs(port, { unknownField: 1 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/未知字段/);
  });

  it('类型不符字段被拒绝', async () => {
    const port = await startTestServer();
    const res = await patchIceEtlPrefs(port, { panelWidth: 'wide' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/panelWidth 须为 number/);
  });

  it('每个 DEFAULT 键的类型错误均返回 400（类型规则由 DEFAULT 派生自动覆盖）', async () => {
    const port = await startTestServer();
    const cases: Array<{ key: string; bad: unknown; errorPattern: RegExp }> = [
      { key: 'showTransparencyPanel', bad: 'yes', errorPattern: /showTransparencyPanel 须为 boolean/ },
      { key: 'panelDefaultExpanded', bad: 1, errorPattern: /panelDefaultExpanded 须为 boolean/ },
      { key: 'panelWidth', bad: 'wide', errorPattern: /panelWidth 须为 number/ },
      { key: 'taskDoneNotification', bad: 'true', errorPattern: /taskDoneNotification 须为 boolean/ },
      { key: 'panelAutoCollapse', bad: 'yes', errorPattern: /panelAutoCollapse 须为 boolean/ },
    ];
    for (const c of cases) {
      const res = await patchIceEtlPrefs(port, { [c.key]: c.bad });
      expect(res.status, `键 ${c.key} 类型错误应 400`).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(c.errorPattern);
    }
  });

  it('校验覆盖由 DEFAULT_ICE_ETL_PREFS 键派生：新增字段无需改路由类型规则', async () => {
    // 路由校验不硬编码任何字段名/类型规则（validateIceEtlPrefsPatch 由 DEFAULT 派生），
    // 因此 DEFAULT + sanitize + types.ts + etl-prefs.js 四处同步后，PATCH 自动接受新键。
    const port = await startTestServer();
    // 当前全部 DEFAULT 键都在 200/400 两条路径上覆盖（见上两例）；
    // 此例断言未知键仍被拒绝，保证 allowedKeys ⊆ DEFAULT 不因派生而放宽。
    const res = await patchIceEtlPrefs(port, { futureField: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/未知字段/);
  });

  it('非法载荷（非对象）被拒绝', async () => {
    const port = await startTestServer();
    const res = await patchIceEtlPrefs(port, 'junk');
    expect(res.status).toBe(400);
  });

  it('合法 patch 持久化并返回归一化结果（panelWidth 夹紧）', async () => {
    const port = await startTestServer();
    const res = await patchIceEtlPrefs(port, { panelWidth: 9999 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iceEtlPrefs).toEqual({
      ...DEFAULT_ICE_ETL_PREFS,
      panelWidth: 480,
    });
  });
});
