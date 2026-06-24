import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeShellSandbox,
  DEFAULT_SHELL_BLACKLIST_PATTERNS,
  resetShellBlacklistCache,
  resolveShellBlacklistPatterns,
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
});
