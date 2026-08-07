import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyShellCollabCommandRisk,
  collectShellCommandSegments,
  normalizeShellCommand,
  resetShellCollabCommandRiskCache,
  splitCompoundShellCommands,
} from '../../src/tools/shell-collab-command-risk.js';
import { DEFAULT_SHELL_BLACKLIST_PATTERNS } from '../../src/tools/shell-sandbox.js';

describe('shell-collab-command-risk', () => {
  let configPath: string;

  beforeEach(() => {
    resetShellCollabCommandRiskCache();
    const dir = mkdtempSync(join(tmpdir(), 'ice-shell-risk-'));
    configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ providers: [], shellBlacklist: DEFAULT_SHELL_BLACKLIST_PATTERNS }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    resetShellCollabCommandRiskCache();
  });

  it('T28: matches default configurable patterns', () => {
    for (const command of ['rm -rf /tmp/x', 'git reset --hard', 'DROP TABLE users']) {
      const risk = classifyShellCollabCommandRisk(command, { configPath });
      expect(risk, command).not.toBeNull();
      expect(risk?.risk).toBe('mandatory_confirm');
      expect(risk?.matchedPattern).toBeTruthy();
      expect(risk?.normalized).toBe(normalizeShellCommand(command));
    }
  });

  it('T37: returns null when command does not match configured patterns', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ providers: [], shellBlacklist: ['rm\\s+-rf'] }, null, 2),
      'utf-8',
    );
    resetShellCollabCommandRiskCache();

    expect(classifyShellCollabCommandRisk('chmod 755 file', { configPath })).toBeNull();
    expect(classifyShellCollabCommandRisk('systemctl status nginx', { configPath })).toBeNull();
  });

  it('T33: detects nested and compound commands', () => {
    const nested = classifyShellCollabCommandRisk('bash -c "git reset --hard"', { configPath });
    expect(nested).not.toBeNull();
    expect(nested?.matchedPattern).toMatch(/git/);

    const compound = classifyShellCollabCommandRisk('echo ok && rm -rf /tmp/x', { configPath });
    expect(compound).not.toBeNull();
    expect(compound?.matchedPattern).toMatch(/rm/);
  });

  it('applies anchored rules to newline and -lc payload segments', () => {
    const patterns = [/^rm\s+-rf/i];

    expect(classifyShellCollabCommandRisk('echo ok\nrm -rf /tmp/x', { patterns })).not.toBeNull();
    expect(classifyShellCollabCommandRisk(
      'bash -lc "echo ok\nrm -rf /tmp/x"',
      { patterns },
    )).not.toBeNull();
    expect(classifyShellCollabCommandRisk(
      'pwsh -Command "bash -lc \'rm -rf /tmp/x\'"',
      { patterns },
    )).not.toBeNull();
    expect(classifyShellCollabCommandRisk('echo "rm -rf /tmp/x"', { patterns })).toBeNull();
  });

  it('splitCompoundShellCommands is quote-aware', () => {
    expect(splitCompoundShellCommands('echo "a;b" && rm -rf /tmp/x')).toEqual([
      'echo "a;b"',
      'rm -rf /tmp/x',
    ]);
  });

  it('collectShellCommandSegments expands bash -c payloads', () => {
    const segments = collectShellCommandSegments('bash -c "git reset --hard"');
    expect(segments.some(s => /git reset --hard/i.test(s))).toBe(true);
  });

  it('empty shellBlacklist disables configurable confirm only', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ providers: [], shellBlacklist: [] }, null, 2),
      'utf-8',
    );
    resetShellCollabCommandRiskCache();
    expect(classifyShellCollabCommandRisk('rm -rf /tmp/x', { configPath })).toBeNull();
  });
});
