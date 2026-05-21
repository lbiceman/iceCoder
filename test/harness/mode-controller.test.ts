import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ModeController, resolveGlobalPolicy } from '../../src/harness/supervisor/mode-controller.js';
import {
  defaultSupervisorConfig,
  loadHarnessSupervisorRuntime,
} from '../../src/harness/supervisor/supervisor-config.js';

describe('ModeController - Batch 1 global policy', () => {
  it('resolves off as disabled decision chain with free floor', () => {
    const policy = resolveGlobalPolicy(
      { ...defaultSupervisorConfig(), mode: 'off', shadow: true },
      {},
    );

    expect(policy).toMatchObject({
      autoDecisionEnabled: false,
      supervisorMode: 'off',
      shadow: false,
      executionModeFloor: 'free',
      observerEnabled: false,
      modeDecisionEngineEnabled: false,
      recoverySupervisorEnabled: false,
      strictCapabilityBundle: false,
    });
  });

  it('resolves adaptive as enabled decision chain with free floor', () => {
    const policy = resolveGlobalPolicy(
      { ...defaultSupervisorConfig(), mode: 'adaptive', shadow: false },
      {},
    );

    expect(policy.modeDecisionEngineEnabled).toBe(true);
    expect(policy.recoverySupervisorEnabled).toBe(true);
    expect(policy.executionModeFloor).toBe('free');
    expect(policy.strictCapabilityBundle).toBe(false);
  });

  it('resolves strict as enabled decision chain with forced floor', () => {
    const policy = resolveGlobalPolicy(
      { ...defaultSupervisorConfig(), mode: 'strict', shadow: false },
      {},
    );

    expect(policy.modeDecisionEngineEnabled).toBe(true);
    expect(policy.recoverySupervisorEnabled).toBe(true);
    expect(policy.executionModeFloor).toBe('forced');
    expect(policy.strictCapabilityBundle).toBe(true);
  });

  it('uses ICE_SUPERVISOR_MODE and ICE_SUPERVISOR_SHADOW only in global policy resolution', () => {
    const policy = resolveGlobalPolicy(
      { ...defaultSupervisorConfig(), mode: 'off', shadow: false },
      { ICE_SUPERVISOR_MODE: 'adaptive', ICE_SUPERVISOR_SHADOW: '1' },
    );

    expect(policy.supervisorMode).toBe('adaptive');
    expect(policy.shadow).toBe(true);
    expect(policy.executionModeFloor).toBe('free');
  });

  it('defaults executionMode.forcedMinDwellRounds to 1', () => {
    expect(defaultSupervisorConfig().executionMode?.forcedMinDwellRounds).toBe(1);
  });

  it('ModeController exposes global policy and mode params without touching harness loop state', () => {
    const controller = new ModeController(
      { ...defaultSupervisorConfig(), mode: 'strict', shadow: false },
      {},
    );

    expect(controller.resolveGlobalPolicy().executionModeFloor).toBe('forced');
    expect(controller.getModeParams().strict.firstRoundGraph).toBe(true);
  });
});

describe('loadHarnessSupervisorRuntime - F2 entrypoint loader', () => {
  it('returns adaptive defaults when dataDir has no supervisor-config.json', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-supervisor-load-'));
    const { supervisorConfig, globalPolicy } = await loadHarnessSupervisorRuntime({ dataDir, env: {} });

    expect(supervisorConfig.mode).toBe('adaptive');
    expect(globalPolicy.modeDecisionEngineEnabled).toBe(true);
    expect(globalPolicy.executionModeFloor).toBe('free');
  });

  it('honors ICE_SUPERVISOR_MODE=off override even when disk says adaptive', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-supervisor-load-'));
    await fs.writeFile(
      path.join(dataDir, 'supervisor-config.json'),
      JSON.stringify({ mode: 'adaptive' }),
      'utf-8',
    );
    const { globalPolicy } = await loadHarnessSupervisorRuntime({
      dataDir,
      env: { ICE_SUPERVISOR_MODE: 'off' },
    });

    expect(globalPolicy.supervisorMode).toBe('off');
    expect(globalPolicy.modeDecisionEngineEnabled).toBe(false);
  });

  it('falls back to off when supervisor-config.json contains invalid JSON', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-supervisor-load-'));
    await fs.writeFile(
      path.join(dataDir, 'supervisor-config.json'),
      '{ this is not valid json',
      'utf-8',
    );
    const { globalPolicy } = await loadHarnessSupervisorRuntime({ dataDir, env: {} });

    expect(globalPolicy.supervisorMode).toBe('off');
    expect(globalPolicy.modeDecisionEngineEnabled).toBe(false);
  });
});
