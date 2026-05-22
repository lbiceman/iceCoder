import type {
  ExecutionModeConfig,
  RuntimeExecutionState,
  TaskRiskClassifier as TaskRiskClassifierContract,
  TaskRiskLevel,
} from '../../types/supervisor.js';

export class TaskRiskClassifier implements TaskRiskClassifierContract {
  constructor(private readonly config: ExecutionModeConfig) {}

  classify(state: RuntimeExecutionState): TaskRiskLevel {
    if (isObservationOnly(state)) {
      return 'L0_observation';
    }
    if (hasStructuralRuntimeRisk(state, this.config)) {
      return 'L2_structural';
    }
    return 'L1_minor_edit';
  }
}

function isObservationOnly(state: RuntimeExecutionState): boolean {
  return !state.taskGraphActive
    && state.pendingStepCount === 0
    && state.writeTargetsThisRound === 0
    && state.plannedWriteTargets === 0
    && state.accumulatedDiffLines === 0
    && !state.branchSwitchedThisRound
    && !state.checkpointResumedThisSession
    && state.lastToolSuccess
    && !state.recoveryPending
    && state.branchDebt === 0
    && !state.activeGraphHasImplementNode
    && state.plannedToolNames.every(toolName => state.readonlyToolNames.includes(toolName));
}

function hasStructuralRuntimeRisk(
  state: RuntimeExecutionState,
  config: ExecutionModeConfig,
): boolean {
  return state.taskGraphActive
    || state.pendingStepCount >= config.pendingStepsEnterThreshold
    || state.writeTargetsThisRound > config.writeTargetsEnterThreshold
    || state.plannedWriteTargets > config.writeTargetsEnterThreshold
    || state.branchSwitchedThisRound
    || state.checkpointResumedThisSession
    || !state.lastToolSuccess
    || state.accumulatedDiffLines > config.diffLinesEnterThreshold
    || state.activeGraphHasImplementNode;
}
