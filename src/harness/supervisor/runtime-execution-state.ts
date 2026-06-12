import type {
  ExecutionMode,
  ModeDecisionContext,
  ModeSignal,
  RuntimeExecutionState,
  SupervisorMode,
  SupervisorPhase,
  TaskRiskLevel,
} from '../../types/supervisor.js';

export interface RuntimeGraphState {
  active: boolean;
  pendingStepCount: number;
  activeGraphHasImplementNode: boolean;
}

export interface BuildRuntimeExecutionStateInput {
  round: number;
  readonlyToolNames: string[];
  plannedToolNames?: string[];
  graphState?: Partial<RuntimeGraphState> | null;
  writeTargetsThisRound?: number;
  plannedWriteTargets?: number;
  accumulatedDiffLines?: number;
  branchSwitchedThisRound?: boolean;
  checkpointResumedThisSession?: boolean;
  lastToolSuccess?: boolean;
  recoveryPending?: boolean;
  branchDebt?: number;
  stableRounds?: number;
  forcedEntryRound?: number | null;
  forcedTaskBearingRoundsSinceEntry?: number;
}

export function buildRuntimeExecutionState(
  input: BuildRuntimeExecutionStateInput,
): RuntimeExecutionState {
  const plannedToolNames = input.plannedToolNames ?? [];
  const graphState = input.graphState ?? {};
  const plannedWriteTargets = input.plannedWriteTargets
    ?? countPlannedWriteTargets(plannedToolNames, input.readonlyToolNames);

  return {
    round: input.round,
    taskGraphActive: graphState.active ?? false,
    pendingStepCount: graphState.pendingStepCount ?? 0,
    writeTargetsThisRound: input.writeTargetsThisRound ?? 0,
    plannedWriteTargets,
    accumulatedDiffLines: input.accumulatedDiffLines ?? 0,
    branchSwitchedThisRound: input.branchSwitchedThisRound ?? false,
    checkpointResumedThisSession: input.checkpointResumedThisSession ?? false,
    lastToolSuccess: input.lastToolSuccess ?? true,
    recoveryPending: input.recoveryPending ?? false,
    branchDebt: input.branchDebt ?? 0,
    stableRounds: input.stableRounds ?? 0,
    activeGraphHasImplementNode: graphState.activeGraphHasImplementNode ?? false,
    readonlyToolNames: [...input.readonlyToolNames],
    plannedToolNames: [...plannedToolNames],
    forcedEntryRound: input.forcedEntryRound ?? null,
    forcedTaskBearingRoundsSinceEntry: input.forcedTaskBearingRoundsSinceEntry ?? 0,
  };
}

export interface BuildModeDecisionContextInput {
  round: number;
  executionMode: ExecutionMode;
  executionModeLockRemaining: number;
  supervisorPhase: SupervisorPhase;
  supervisorMode: SupervisorMode;
  riskLevel: TaskRiskLevel;
  state: RuntimeExecutionState;
  signals?: ModeSignal[];
}

export function buildModeDecisionContext(
  input: BuildModeDecisionContextInput,
): ModeDecisionContext {
  return {
    round: input.round,
    executionMode: input.executionMode,
    executionModeLockRemaining: input.executionModeLockRemaining,
    supervisorPhase: input.supervisorPhase,
    supervisorMode: input.supervisorMode,
    riskLevel: input.riskLevel,
    state: input.state,
    signals: [...(input.signals ?? [])],
  };
}

function countPlannedWriteTargets(plannedToolNames: string[], readonlyToolNames: string[]): number {
  const readonlySet = new Set(readonlyToolNames);
  return plannedToolNames.filter(toolName => !readonlySet.has(toolName)).length;
}
