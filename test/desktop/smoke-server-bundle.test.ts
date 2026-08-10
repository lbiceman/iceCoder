import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '../../desktop/scripts/smoke-server-bundle.mjs');
const ENTRY = path.join(__dirname, '../../desktop/server-bundle/dist/index.js');

const entryExists = fs.existsSync(ENTRY);

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 40_000);
}

describe('桌面 server-bundle smoke（构建产物存在时）', () => {
  it.skipIf(!entryExists)(
    'smoke-server-bundle 启动 server 并健康检查通过（退出码 0）',
    async () => {
      const port = randomPort();
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT, `--port=${port}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? -1));
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }, 30_000);
        child.on('exit', () => clearTimeout(timer));
      });
      expect(exitCode).toBe(0);
    },
    40_000,
  );
});
