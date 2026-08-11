import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServerProcess } from '../../desktop/src/server-process.js';
import { isPortFree } from '../../desktop/src/port-utils.js';

const BUNDLE_ENTRY = path.join(__dirname, '../../desktop/server-bundle/dist/index.js');

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 40_000);
}

describe('startServerProcess（server 子进程管理，bundle 存在时）', () => {
  const bundleExists = (() => {
    try {
      return require('node:fs').existsSync(BUNDLE_ENTRY);
    } catch {
      return false;
    }
  })();

  it.skipIf(!bundleExists)(
    '启动 server、健康检查通过、stop 后端口释放',
    async () => {
      const port = randomPort();
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'ice-server-cwd-'));

      try {
        const handle = await startServerProcess({
          port,
          cwd,
          electronRunAsNode: false,
          nodeBin: process.execPath,
        });
        expect(handle.port).toBe(port);
        expect(handle.url).toBe(`http://127.0.0.1:${port}`);
        expect(handle.child.pid).toBeGreaterThan(0);

        await handle.stop();
        // 停止后端口应可被再次占用（等待 taskkill 生效）
        await new Promise((r) => setTimeout(r, 1500));
        expect(await isPortFree(port)).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
