import type {
  GlobalModePolicy,
  ModeController as ModeControllerContract,
  SupervisorConfigFile,
  SupervisorMode,
  SupervisorParams,
} from '../../types/supervisor.js';

/** Env keys are parsed only here at the Global layer; local runtime modules receive policy/config objects. */
export function resolveGlobalPolicy(
  config: Pick<SupervisorConfigFile, 'mode' | 'shadow'>,
  env: NodeJS.ProcessEnv = process.env,
): GlobalModePolicy {
  const supervisorMode = resolveSupervisorMode(env.ICE_SUPERVISOR_MODE, config.mode);
  const shadow = supervisorMode === 'off'
    ? false
    : resolveBooleanEnv(env.ICE_SUPERVISOR_SHADOW, config.shadow);
  const enabled = supervisorMode !== 'off';
  const strict = supervisorMode === 'strict';

  return {
    autoDecisionEnabled: enabled,
    supervisorMode,
    shadow,
    executionModeFloor: strict ? 'forced' : 'free',
    observerEnabled: enabled,
    modeDecisionEngineEnabled: enabled,
    recoverySupervisorEnabled: enabled,
    strictCapabilityBundle: strict,
  };
}

export class ModeController implements ModeControllerContract {
  constructor(
    private readonly config: SupervisorConfigFile,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  resolveGlobalPolicy(): GlobalModePolicy {
    return resolveGlobalPolicy(this.config, this.env);
  }

  getModeParams(): SupervisorParams {
    return this.config.params;
  }
}

function resolveSupervisorMode(value: string | undefined, fallback: SupervisorMode): SupervisorMode {
  if (value === 'off' || value === 'adaptive' || value === 'strict') {
    return value;
  }
  return fallback;
}

function resolveBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return fallback;
}
