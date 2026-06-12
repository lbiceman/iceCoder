/**
 * server-process.ts
 * 负责：spawn iceCoder server 子进程、健康检查、终止整棵进程树。
 */
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { getServerRoot } from './constants';
import {
  HEALTHCHECK_MAX_WAIT_MS,
  HEALTHCHECK_PATH,
  HEALTHCHECK_TIMEOUT_MS,
} from './constants';
import { writeConsole } from './console-output';

export interface ServerProcessOptions {
  port: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** spawn 时使用的 node 可执行文件；默认 process.execPath（Electron Node 模式）。 */
  nodeBin?: string;
  /** 是否使用 ELECTRON_RUN_AS_NODE（Electron 环境下默认 true）。 */
  electronRunAsNode?: boolean;
}

export interface ServerProcessHandle {
  child: ChildProcess;
  port: number;
  url: string;
  stop(): Promise<void>;
}

function buildEnv(opts: ServerProcessOptions, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const useElectronNode = opts.electronRunAsNode !== false;
  return {
    ...base,
    NODE_ENV: 'production',
    PORT: String(opts.port),
    ICE_ELECTRON: '1',
    ICE_SERVER_ROOT: getServerRoot(),
    ...(useElectronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}

function httpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: HEALTHCHECK_PATH, timeout: timeoutMs },
      (res) => {
        res.resume();
        // 任何 HTTP 响应即视为已就绪
        resolve(res.statusCode !== undefined);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port: number, host = '127.0.0.1'): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTHCHECK_MAX_WAIT_MS) {
    if (await httpProbe(host, port, HEALTHCHECK_TIMEOUT_MS)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function startServerProcess(
  opts: ServerProcessOptions,
): Promise<ServerProcessHandle> {
  const serverRoot = getServerRoot();
  const entry = path.join(serverRoot, 'dist', 'index.js');
  const useElectronNode = opts.electronRunAsNode !== false;
  const bin = useElectronNode ? process.execPath : (opts.nodeBin || 'node');
  const env = buildEnv(opts, opts.env || process.env);

  const child = spawn(bin, [entry], {
    cwd: opts.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  const stderrLines: string[] = [];
  const forwardServerLog = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    writeConsole(stream, `[server] ${chunk.toString('utf8')}`);
  };
  child.stdout?.on('data', (b) => forwardServerLog(b, process.stdout));
  child.stderr?.on('data', (b) => {
    const text = b.toString('utf8');
    forwardServerLog(b, process.stderr);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) stderrLines.push(line.trim());
    }
    if (stderrLines.length > 12) stderrLines.splice(0, stderrLines.length - 12);
  });

  child.on('exit', (code, signal) => {
    writeConsole(process.stderr, `[server] exit code=${code} signal=${signal}\n`);
  });

  const ready = await waitForServer(opts.port);
  if (!ready) {
    try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    const hint = stderrLines.length
      ? `\n最近 server stderr:\n${stderrLines.map((l) => `  ${l}`).join('\n')}`
      : '';
    const bundleHint = !fs.existsSync(entry)
      ? '\n提示：未找到 server-bundle，请先运行 npm run build:desktop:server'
      : '';
    throw new Error(
      `iceCoder server did not become ready on port ${opts.port} within ${HEALTHCHECK_MAX_WAIT_MS}ms${bundleHint}${hint}`,
    );
  }

  return {
    child,
    port: opts.port,
    url: `http://127.0.0.1:${opts.port}`,
    stop: () => stopServer(child),
  };
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.once('exit', done);

    // 先 SIGTERM，让 server 有机会终止后台 shell / MCP
    try { child.kill('SIGTERM'); } catch { /* ignore */ }

    const forceTimer = setTimeout(() => {
      if (child.exitCode !== null || child.killed) {
        done();
        return;
      }
      if (process.platform === 'win32' && child.pid) {
        try {
          const { spawn: sp } = require('node:child_process') as typeof import('node:child_process');
          sp('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            .on('exit', done)
            .on('error', done);
        } catch {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          done();
        }
        return;
      }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      done();
    }, 8000);
    forceTimer.unref?.();
  });
}
