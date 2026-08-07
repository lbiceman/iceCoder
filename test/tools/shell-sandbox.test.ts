import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeShellSandbox,
  DEFAULT_SHELL_BLACKLIST_PATTERNS,
  resetShellBlacklistCache,
  resolveShellBlacklistPatterns,
  validateShellBlacklistPatterns,
} from '../../src/tools/shell-sandbox.js';

describe('shell-sandbox', () => {
  let configPath: string;

  beforeEach(() => {
    resetShellBlacklistCache();
    const dir = mkdtempSync(join(tmpdir(), 'ice-sandbox-'));
    configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ providers: [] }, null, 2), 'utf-8');
  });

  afterEach(() => {
    resetShellBlacklistCache();
  });

  it('blocks host-kill patterns', () => {
    const result = analyzeShellSandbox('taskkill /F /IM node.exe', { configPath });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('host_kill');
  });

  it('allows taskkill by PID', () => {
    const result = analyzeShellSandbox('taskkill /F /PID 12345', { configPath });
    expect(result.blocked).toBe(false);
  });

  it('blocks rm -rf via default blacklist', () => {
    const result = analyzeShellSandbox('rm -rf /tmp/foo', { configPath });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('blacklist');
  });

  it('can defer configurable matches to shellMandatoryConfirm while retaining hard block', () => {
    expect(
      analyzeShellSandbox('rm -rf /tmp/foo', { configPath, includeBlacklist: false }).blocked,
    ).toBe(false);
    expect(
      analyzeShellSandbox('rm -rf /', { configPath, includeBlacklist: false }).reason,
    ).toBe('hard_block');
  });

  it('hard-blocks catastrophic commands even when shellBlacklist is disabled', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ providers: [], shellBlacklist: [] }, null, 2),
      'utf-8',
    );
    resetShellBlacklistCache();

    for (const command of ['rm -rf /', 'sudo rm -fr -- /*', 'format C: /q']) {
      const result = analyzeShellSandbox(command, { configPath });
      expect(result.blocked, command).toBe(true);
      expect(result.reason, command).toBe('hard_block');
    }
  });

  it('hard-blocks expanded nested and multiline catastrophic commands', () => {
    const commands = [
      'echo safe\nrm -rf /',
      'bash -lc "echo safe\nrm -rf /"',
      'cmd /c "echo safe && rm -rf /"',
      'pwsh -Command "bash -lc \'rm -rf /\'"',
      '(rm -rf /)',
      '{ rm -rf / }',
    ];

    for (const command of commands) {
      const result = analyzeShellSandbox(command, {
        configPath,
        includeBlacklist: false,
      });
      expect(result.blocked, command).toBe(true);
      expect(result.reason, command).toBe('hard_block');
    }
  });

  it('does not treat quoted command text as an executable subcommand', () => {
    expect(
      analyzeShellSandbox('echo "rm -rf /"', { configPath, includeBlacklist: false }).blocked,
    ).toBe(false);
  });

  it('allows ordinary rm', () => {
    const result = analyzeShellSandbox('rm dist/output.txt', { configPath });
    expect(result.blocked).toBe(false);
  });

  it('uses custom shellBlacklist from config', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ providers: [], shellBlacklist: ['curl\\s+'] }, null, 2),
      'utf-8',
    );
    resetShellBlacklistCache();
    expect(analyzeShellSandbox('curl https://example.com', { configPath }).blocked).toBe(true);
    expect(analyzeShellSandbox('echo ok', { configPath }).blocked).toBe(false);
  });

  it('empty shellBlacklist disables blacklist only', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ providers: [], shellBlacklist: [] }, null, 2),
      'utf-8',
    );
    resetShellBlacklistCache();
    expect(analyzeShellSandbox('rm -rf /tmp/foo', { configPath }).blocked).toBe(false);
    expect(analyzeShellSandbox('taskkill /F /IM node.exe', { configPath }).blocked).toBe(true);
  });

  it('resolveShellBlacklistPatterns falls back to defaults', () => {
    expect(resolveShellBlacklistPatterns(undefined)).toEqual(DEFAULT_SHELL_BLACKLIST_PATTERNS);
    expect(resolveShellBlacklistPatterns([])).toEqual([]);
  });

  it('validateShellBlacklistPatterns rejects invalid regex', () => {
    expect(validateShellBlacklistPatterns(['rm\\s+-rf'])).toBeNull();
    expect(validateShellBlacklistPatterns(['('])).toMatch(/无效的正则表达式/);
  });
});
