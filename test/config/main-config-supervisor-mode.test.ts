import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  readSkipPermissionChecksFromMainConfig,
  readSupervisorModeFromMainConfig,
  resolveSkipPermissionChecks,
  writeShellBlacklistToMainConfig,
  writeSkipPermissionChecksToMainConfig,
  writeSupervisorModeToMainConfig,
} from '../../src/config/main-config-supervisor-mode.js';

describe('main-config-supervisor-mode', () => {
  it('reads and writes supervisorMode in config.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-config-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ providers: [], supervisorMode: 'strict' }, null, 2),
      'utf-8',
    );

    expect(await readSupervisorModeFromMainConfig(configPath)).toBe('strict');
    const saved = await writeSupervisorModeToMainConfig(configPath, 'off');
    expect(saved).toBe('off');
    expect(await readSupervisorModeFromMainConfig(configPath)).toBe('off');
  });

  it('resolveSkipPermissionChecks only true for literal true', () => {
    expect(resolveSkipPermissionChecks(true)).toBe(true);
    expect(resolveSkipPermissionChecks(false)).toBe(false);
    expect(resolveSkipPermissionChecks(undefined)).toBe(false);
    expect(resolveSkipPermissionChecks('true')).toBe(false);
  });

  it('readSkipPermissionChecksFromMainConfig reads skipPermissionChecks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-config-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ providers: [], skipPermissionChecks: true }, null, 2),
      'utf-8',
    );

    expect(await readSkipPermissionChecksFromMainConfig(configPath)).toBe(true);
  });

  it('writeSkipPermissionChecksToMainConfig persists boolean', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-config-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    );

    expect(await writeSkipPermissionChecksToMainConfig(configPath, true)).toBe(true);
    expect(await readSkipPermissionChecksFromMainConfig(configPath)).toBe(true);
    expect(await writeSkipPermissionChecksToMainConfig(configPath, false)).toBe(false);
    expect(await readSkipPermissionChecksFromMainConfig(configPath)).toBe(false);
  });

  it('writeShellBlacklistToMainConfig persists patterns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-config-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    );

    const saved = await writeShellBlacklistToMainConfig(configPath, ['  rm\\s+-rf  ', '', 'git\\s+push']);
    expect(saved).toEqual(['rm\\s+-rf', 'git\\s+push']);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { shellBlacklist?: string[] };
    expect(raw.shellBlacklist).toEqual(['rm\\s+-rf', 'git\\s+push']);
  });

});
