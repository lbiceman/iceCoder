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
  const supervisorMode = coalesceSupervisorMode(config.mode);
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

function coalesceSupervisorMode(mode: SupervisorMode | undefined): SupervisorMode {
  if (mode === 'off' || mode === 'adaptive' || mode === 'strict') {
    return mode;
  }
  return 'adaptive';
}

function resolveBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return fallback;
}
