/**
 * L0/L1 监管类型：产品档位、execution mode 与 ToolGate 契约。
 * 运行时模块通过 `.js` specifier 解析到本文件。
 */
import type { ToolCall } from '../llm/types.js';

export type SupervisorMode = 'off' | 'adaptive' | 'strict';
export type ExecutionMode = 'free' | 'forced';

export interface GlobalModePolicy {
  supervisorMode: SupervisorMode;
  executionModeFloor: ExecutionMode;
  modeDecisionEngineEnabled: boolean;
}

export interface ExecutionModeConfig {
  pendingStepsEnterThreshold: number;
  writeTargetsEnterThreshold: number;
  diffLinesEnterThreshold: number;
  stableRoundsExitThreshold: number;
  modeLockRounds: number;
  forcedMinDwellRounds: number;
  readonlyToolNames: string[];
}

export interface SupervisorConfigFile {
  mode: SupervisorMode;
  executionMode?: ExecutionModeConfig;
}

export interface ResolvedSupervisorConfig extends SupervisorConfigFile {
  executionMode: ExecutionModeConfig;
  globalPolicy: GlobalModePolicy;
}

export type TaskRiskLevel = 'L0_observation' | 'L1_minor_edit' | 'L2_structural';

export type ModeSignal =
  | 'task_graph_active'
  | 'pending_steps'
  | 'multi_write'
  | 'branch_switched'
  | 'checkpoint_resumed'
  | 'tool_failure'
  | 'recovery_pending'
  | 'large_diff'
  | 'explicit_impl'
  | 'engine_fail_safe';

export const MODE_SIGNAL_PRECEDENCE: readonly ModeSignal[] = [
  'checkpoint_resumed',
  'task_graph_active',
  'branch_switched',
  'pending_steps',
  'tool_failure',
  'multi_write',
  'large_diff',
  'explicit_impl',
] as const;

export type ForcedDegradedTier = 'graph' | 'step_queue' | 'write_intent';

export interface ExecutionModeTelemetryPayload {
  executionMode: ExecutionMode;
  enteredBy: ModeSignal[];
  enteredByPrimary?: ModeSignal;
  primaryReasonHuman: string;
  round: number;
  failSafe?: boolean;
  degradedTier?: ForcedDegradedTier;
  forcedTaskBearingRoundsSinceEntry?: number;
  forcedMinDwellRounds?: number;
  exitDeniedReason?: 'mode_lock' | 'min_dwell' | 'exit_conditions';
}

export type ModeSignalSource =
  | 'graph_executor'
  | 'checkpoint_engine'
  | 'step_gate'
  | 'branch_budget'
  | 'tool_gate'
  | 'stop_hook';

export interface RuntimeExecutionState {
  round: number;
  taskGraphActive: boolean;
  pendingStepCount: number;
  writeTargetsThisRound: number;
  plannedWriteTargets: number;
  accumulatedDiffLines: number;
  branchSwitchedThisRound: boolean;
  checkpointResumedThisSession: boolean;
  lastToolSuccess: boolean;
  recoveryPending: boolean;
  branchDebt: number;
  stableRounds: number;
  activeGraphHasImplementNode: boolean;
  readonlyToolNames: string[];
  plannedToolNames: string[];
  forcedEntryRound: number | null;
  forcedTaskBearingRoundsSinceEntry: number;
}

export interface TaskBearingRoundOutcome {
  hadSuccessfulToolExecute: boolean;
  graphStepAdvanced: boolean;
  writeToolSucceededWithFileChange: boolean;
}

export interface ModeDecisionEngine {
  evaluate(ctx: ModeDecisionContext): ModeDecision;
  submitSignal(source: ModeSignalSource, signal: ModeSignal, payload?: Record<string, unknown>): void;
}

export interface TaskRiskClassifier {
  classify(state: RuntimeExecutionState): TaskRiskLevel;
}

export interface ModeDecisionContext {
  round: number;
  executionMode: ExecutionMode;
  executionModeLockRemaining: number;
  supervisorMode: SupervisorMode;
  riskLevel: TaskRiskLevel;
  state: RuntimeExecutionState;
  signals: ModeSignal[];
}

export type ModeDecision =
  | { action: 'keep'; mode: ExecutionMode }
  | {
      action: 'enter_forced';
      reason: ModeSignal[];
      lockRounds: number;
      enteredBy: ModeSignal[];
      primaryReason: ModeSignal;
      failSafe?: boolean;
    }
  | { action: 'exit_forced'; reason: string };

export type ToolGateAction = 'execute' | 'skip';

export interface ToolGateEntry {
  toolCallId: string;
  action: ToolGateAction;
  message?: string;
}

export interface ToolGatePlan {
  entries: ToolGateEntry[];
}

export interface ToolGate {
  decide(calls: ToolCall[], ctx: GateContext): ToolGatePlan;
}

export interface GateContext {
  executionMode: ExecutionMode;
  graphHints: Array<{ toolName: string; action: 'allow' | 'warn' | 'block'; message?: string }>;
}
