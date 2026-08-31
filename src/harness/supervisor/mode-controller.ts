import type {
  GlobalModePolicy,
  SupervisorConfigFile,
  SupervisorMode,
} from '../../types/supervisor.js';

export function resolveGlobalPolicy(
  config: Pick<SupervisorConfigFile, 'mode'>,
): GlobalModePolicy {
  const supervisorMode = coalesceSupervisorMode(config.mode);
  const enabled = supervisorMode !== 'off';
  const strict = supervisorMode === 'strict';

  return {
    supervisorMode,
    executionModeFloor: strict ? 'forced' : 'free',
    modeDecisionEngineEnabled: enabled,
  };
}

function coalesceSupervisorMode(mode: SupervisorMode | undefined): SupervisorMode {
  if (mode === 'off' || mode === 'adaptive' || mode === 'strict') {
    return mode;
  }
  return 'adaptive';
}
