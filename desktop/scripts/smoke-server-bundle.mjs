#!/usr/bin/env node
/**
 * smoke-server-bundle.mjs
 * 验证 desktop/server-bundle/dist/index.js 可以成功 require / 启动端口监听。
 *
 * 用法: node desktop/scripts/smoke-server-bundle.mjs [--port=4096]
 * 退出码: 0 通过；非 0 失败。
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.resolve(__dirname, '..', 'server-bundle');
const distEntry = path.join(bundleDir, 'dist', 'index.js');

function parsePort() {
  const arg = process.argv.find((a) => a.startsWith('--port='));
  return arg ? Number(arg.split('=')[1]) : 4096;
}

function main() {
  if (!fs.existsSync(distEntry)) {
    process.stderr.write(`[smoke] missing entry: ${distEntry}\n`);
    process.stderr.write('[smoke] run: npm run build:desktop:server\n');
    process.exit(2);
  }
  const port = parsePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    ICE_DATA_DIR: path.join(os.homedir(), '.iceCoder-smoke'),
  };

  const child = spawn(process.execPath, [distEntry], {
    cwd: bundleDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  child.stdout.on('data', (b) => process.stdout.write(b));
  child.stderr.on('data', (b) => {
    stderrBuf += b.toString();
    process.stderr.write(b);
  });

  const timeoutMs = 15_000;
  const start = Date.now();

  function probe() {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      cleanup(0);
    });
    req.on('error', () => {
      if (Date.now() - start > timeoutMs) {
        process.stderr.write('[smoke] TIMEOUT waiting for server\n');
        cleanup(3);
        return;
      }
      setTimeout(probe, 250);
    });
  }

  function cleanup(code) {
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
    setTimeout(() => process.exit(code), 200);
  }

  setTimeout(probe, 500);
}

main();
