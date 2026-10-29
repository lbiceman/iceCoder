import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __resetHostListenPortsForTest,
  analyzeShellHostSafety,
  buildShellChildEnv,
  checkHostGuardWritePreflight,
  findHostKillInText,
  isHostListenPort,
  isProtectedHostPid,
  registerHostListenPort,
} from '../../src/tools/shell-host-guard.js';
import { analyzeShellSandbox } from '../../src/tools/shell-sandbox.js';

function writeScript(name: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ice-host-guard-'));
  writeFileSync(join(root, name), content, 'utf-8');
  return root;
}

describe('shell-host-guard', () => {
  it('detects taskkill /IM node in text', () => {
    expect(findHostKillInText("execSync('taskkill /F /IM node.exe 2>nul')")).toBe('taskkill /IM node');
  });

  it('allows taskkill by other PID', () => {
    expect(findHostKillInText('taskkill /F /PID 12345')).toBeNull();
  });

  it('blocks taskkill on agent root PID', () => {
    const cmd = `taskkill /F /PID ${process.pid}`;
    expect(findHostKillInText(cmd)).toBe('taskkill /PID agent root');
    const result = analyzeShellHostSafety(cmd);
    expect(result.blocked).toBe(true);
    expect(result.matchLabel).toBe('taskkill /PID agent root');
  });

  it('blocks taskkill using ICE_AGENT_ROOT_PID', () => {
    expect(findHostKillInText('taskkill /F /PID %ICE_AGENT_ROOT_PID%')).toBe('taskkill /PID agent root');
  });

  it('blocks kill on agent root PID', () => {
    expect(findHostKillInText(`kill -9 ${process.pid}`)).toBe('kill agent root pid');
  });

  it('blocks direct run_command with broad kill', () => {
    const result = analyzeShellHostSafety('taskkill /F /IM node.exe');
    expect(result.blocked).toBe(true);
    expect(result.message).toMatch(/HostGuard/);
  });

  it('blocks node script that kills all node processes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-host-guard-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts', 'bad.cjs'),
      "require('child_process').execSync('taskkill /F /IM node.exe');\n",
      'utf-8',
    );

    const result = analyzeShellHostSafety('node scripts/bad.cjs 2>&1', { workDir: root });
    expect(result.blocked).toBe(true);
    expect(result.message).toMatch(/scripts\/bad\.cjs/);
  });

  it('allows node script without host-kill patterns', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-host-guard-'));
    writeFileSync(join(root, 'ok.cjs'), "console.log('hello');\n", 'utf-8');

    const result = analyzeShellHostSafety('node ok.cjs', { workDir: root });
    expect(result.blocked).toBe(false);
  });

  it('blocks write_file content with killall node', () => {
    const result = checkHostGuardWritePreflight('write_file', {
      path: 'scripts/x.cjs',
      content: "require('child_process').execSync('killall node');",
    });
    expect(result.blocked).toBe(true);
    expect(result.matchLabel).toBe('killall node');
  });

  it('injects ICE_AGENT_ROOT_PID into child env', () => {
    const env = buildShellChildEnv('sess-1');
    expect(env.ICE_AGENT_ROOT_PID).toBe(String(process.pid));
    expect(env.ICE_AGENT_SESSION).toBe('sess-1');
  });
});

describe('shell-host-guard: packaged desktop host (iceCoder.exe)', () => {
  const savedElectron = process.env.ICE_ELECTRON;

  afterEach(() => {
    if (savedElectron === undefined) delete process.env.ICE_ELECTRON;
    else process.env.ICE_ELECTRON = savedElectron;
    __resetHostListenPortsForTest();
  });

  it.each([
    ['taskkill /IM iceCoder.exe /T /F', 'taskkill /IM icecoder'],
    ['taskkill /F /FI "IMAGENAME eq iceCoder.exe"', 'taskkill /FI IMAGENAME icecoder'],
    ["Stop-Process -Name 'iceCoder' -Force", 'Stop-Process -Name icecoder'],
    ['powershell -Command "Get-Process iceCoder | Stop-Process -Force"', 'Get-Process icecoder | Stop-Process'],
    ['pkill -f iceCoder', 'pkill icecoder'],
  ])('blocks broad kill by app image name: %s', (cmd, label) => {
    const result = analyzeShellHostSafety(cmd);
    expect(result.blocked).toBe(true);
    expect(result.matchLabel).toBe(label);
  });

  it('blocks a script that filters processes by app name then kills by Id', () => {
    const root = writeScript(
      '_mem.ps1',
      [
        "$procs = @(Get-Process | Where-Object { $_.ProcessName -like 'iceCoder*' })",
        'foreach ($p in $procs) { Stop-Process -Id $p.Id -Force }',
      ].join('\n'),
    );
    const result = analyzeShellHostSafety('powershell -NoProfile -File _mem.ps1', { workDir: root });
    expect(result.blocked).toBe(true);
    expect(result.message).toMatch(/_mem\.ps1/);
  });

  it('blocks a node script that taskkills iceCoder.exe by image name', () => {
    const root = writeScript(
      '_launch.mjs',
      "import { execSync } from 'node:child_process';\nexecSync(`taskkill /IM iceCoder.exe /T /F`);\n",
    );
    const result = analyzeShellHostSafety('node _launch.mjs', { workDir: root });
    expect(result.blocked).toBe(true);
  });

  it('allows launching a test copy and stopping it by its own PID', () => {
    const root = writeScript(
      'bench.mjs',
      [
        "import { spawn, execSync } from 'node:child_process';",
        "const child = spawn('D:\\\\work\\\\self\\\\iceCoder\\\\desktop\\\\release\\\\win-unpacked\\\\iceCoder.exe');",
        'execSync(`taskkill /PID ${child.pid} /T /F`);',
      ].join('\n'),
    );
    const result = analyzeShellHostSafety('node bench.mjs', { workDir: root });
    expect(result.blocked).toBe(false);
  });

  it('does not treat the repo directory name as a process selector', () => {
    const result = analyzeShellHostSafety('cd d:\\work\\self\\iceCoder && npx kill-port 5173');
    expect(result.blocked).toBe(false);
  });

  it('keeps write preflight to node/tsx so iceCoder sources and tests stay editable', () => {
    const result = checkHostGuardWritePreflight('write_file', {
      path: 'test/x.test.ts',
      content: "expect(guard('taskkill /IM iceCoder.exe')).toBe(true);",
    });
    expect(result.blocked).toBe(false);
  });

  it('protects the Electron main process (server parent) in desktop runtime', () => {
    process.env.ICE_ELECTRON = '1';
    expect(isProtectedHostPid(process.ppid)).toBe(true);
    const result = analyzeShellHostSafety(`taskkill /F /T /PID ${process.ppid}`);
    expect(result.blocked).toBe(true);
  });

  it('does not protect the parent PID outside desktop runtime', () => {
    delete process.env.ICE_ELECTRON;
    expect(isProtectedHostPid(process.ppid)).toBe(false);
  });

  it('catches piped kills that segment splitting used to hide', () => {
    const result = analyzeShellSandbox('powershell -Command Get-Process node | Stop-Process', {
      includeBlacklist: false,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('host_kill');
  });

  it('remembers the host listen port so port-based cleanup can skip it', () => {
    expect(isHostListenPort(1024)).toBe(false);
    registerHostListenPort(1024);
    expect(isHostListenPort(1024)).toBe(true);
  });
});
