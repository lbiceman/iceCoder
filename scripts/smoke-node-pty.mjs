#!/usr/bin/env node
/**
 * smoke-node-pty.mjs
 * 验证 node-pty 可在本机 spawn shell 并读到输出（Windows ConPTY / Unix PTY）。
 *
 * 用法: node scripts/smoke-node-pty.mjs
 * 退出码: 0 通过；非 0 失败。
 */
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as pty from 'node-pty';

const TIMEOUT_MS = 10_000;

function resolveShell() {
  if (platform() === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
  }
  const shell = process.env.SHELL || '/bin/bash';
  return { file: shell, args: ['-i'] };
}

function fail(message, code = 1) {
  process.stderr.write(`[smoke:node-pty] ${message}\n`);
  process.exit(code);
}

function main() {
  const { file, args } = resolveShell();
  process.stdout.write(`[smoke:node-pty] spawning ${file} ${args.join(' ')}\n`);

  let proc;
  try {
    proc = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (err) {
    fail(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let output = '';
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    fail(`TIMEOUT after ${TIMEOUT_MS}ms (got ${output.length} bytes)`, 2);
  }, TIMEOUT_MS);

  proc.onData((data) => {
    output += data;
    if (output.trim().length > 0) {
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      const preview = output.replace(/\r?\n/g, '\\n').slice(0, 120);
      process.stdout.write(`[smoke:node-pty] ok (${output.length} bytes): ${preview}\n`);
      process.exit(0);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    clearTimeout(timer);
    if (output.trim().length > 0) {
      process.stdout.write(`[smoke:node-pty] ok (exit ${exitCode ?? signal})\n`);
      process.exit(0);
    }
    fail(`shell exited before output (code=${exitCode}, signal=${signal})`, 3);
  });
}

main();
