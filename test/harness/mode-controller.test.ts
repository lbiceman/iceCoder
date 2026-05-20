import { describe, expect, it } from 'vitest';

import { ModeController, resolveGlobalPolicy } from '../../src/harness/supervisor/mode-controller.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';

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
