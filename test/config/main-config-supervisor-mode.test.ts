import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  readSkipPermissionChecksFromMainConfig,
  readSupervisorModeFromMainConfig,
  resolveSkipPermissionChecks,
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

});
