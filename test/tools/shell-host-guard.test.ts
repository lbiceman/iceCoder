import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeShellHostSafety,
  buildShellChildEnv,
  checkHostGuardWritePreflight,
  findHostKillInText,
} from '../../src/tools/shell-host-guard.js';

describe('shell-host-guard', () => {
  it('detects taskkill /IM node in text', () => {
    expect(findHostKillInText("execSync('taskkill /F /IM node.exe 2>nul')")).toBe('taskkill /IM node');
  });

  it('allows taskkill by PID', () => {
    expect(findHostKillInText('taskkill /F /PID 12345')).toBeNull();
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
