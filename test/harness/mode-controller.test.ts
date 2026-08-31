import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGlobalPolicy } from '../../src/harness/supervisor/mode-controller.js';
import {
  loadHarnessSupervisorRuntime,
} from '../../src/harness/supervisor/supervisor-config.js';

describe('single-axis supervisor policy', () => {
  it.each([
    ['off', 'free', false],
    ['adaptive', 'free', true],
    ['strict', 'forced', true],
  ] as const)('resolves %s policy', (mode, floor, enabled) => {
    expect(resolveGlobalPolicy({ mode })).toEqual({
      supervisorMode: mode,
      executionModeFloor: floor,
      modeDecisionEngineEnabled: enabled,
    });
  });

  it('loads compact config without creating an L2 bridge', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-single-axis-'));
    await fs.writeFile(
      path.join(dataDir, 'supervisor-config.json'),
      JSON.stringify({ mode: 'adaptive', executionMode: { modeLockRounds: 4 } }),
      'utf-8',
    );
    const runtime = await loadHarnessSupervisorRuntime({
      dataDir,
      mainConfigPath: path.join(dataDir, 'missing-main.json'),
      env: {},
    });
    expect(runtime.globalPolicy.supervisorMode).toBe('adaptive');
    expect(runtime.supervisorConfig.executionMode.modeLockRounds).toBe(4);
    expect('bridge' in runtime).toBe(false);
  });

  it('falls back to off for invalid JSON', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-single-axis-bad-'));
    await fs.writeFile(path.join(dataDir, 'supervisor-config.json'), '{bad', 'utf-8');
    const runtime = await loadHarnessSupervisorRuntime({
      dataDir,
      mainConfigPath: path.join(dataDir, 'missing-main.json'),
      env: {},
    });
    expect(runtime.globalPolicy.supervisorMode).toBe('off');
  });
});
