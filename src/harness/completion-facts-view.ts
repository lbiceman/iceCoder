import type { ProjectCheckpointCompletion } from '../types/runtime-checkpoint.js';
import type { TaskStateSnapshot } from '../types/runtime-snapshot.js';
import type { CompletionCondition } from './completion-condition.js';
import type { CompletionGateInput } from './completion-gate.js';
import type { HarnessRunState } from './harness-run-state.js';
import {
  OperationOutcomeLedger,
  type OperationOutcome,
} from './operation-outcome.js';

export type VerificationSignalStatus = 'not_required' | 'pending' | 'passed' | 'failed';

export interface VerificationSignal {
  status: VerificationSignalStatus;
  required: boolean;
  scope?: string;
  evidenceRefs: string[];
}

export interface CompletionFactsViewOptions {
  additionalConditions?: readonly CompletionCondition[];
  canExecuteRequiredConditions?: boolean;
}

/**
 * conditions / outcomes / completion control 的唯一执行期查询面。
 */
export class CompletionFactsView {
  private readonly conditions: CompletionCondition[];
  private readonly outcomes: OperationOutcome[];
  private readonly executionTask?: TaskStateSnapshot;
  private readonly control: Pick<
    CompletionGateInput,
    'continuationCount' | 'previousBlockingSignature'
  >;

  private constructor(args: {
    conditions?: readonly CompletionCondition[];
    outcomes?: readonly OperationOutcome[];
    executionTask?: TaskStateSnapshot;
    continuationCount?: number;
    previousBlockingSignature?: string;
  }) {
    this.conditions = (args.conditions ?? []).map(cloneCondition);
    this.outcomes = (args.outcomes ?? []).map(cloneOutcome);
    this.executionTask = args.executionTask
      ? cloneTaskSnapshot(args.executionTask)
      : undefined;
    this.control = {
      continuationCount: args.continuationCount,
      previousBlockingSignature: args.previousBlockingSignature,
    };
  }

  static fromHarnessRunState(
    state: HarnessRunState,
    options: CompletionFactsViewOptions = {},
  ): CompletionFactsView {
    const tracked = state.taskAcceptance?.toCompletionConditions(
      options.canExecuteRequiredConditions ?? true,
    ) ?? [];
    const conditions = new Map<string, CompletionCondition>();
    for (const condition of state.restoredCompletionConditions ?? []) {
      conditions.set(condition.id, condition);
    }
    for (const condition of tracked) {
      const restored = conditions.get(condition.id);
      // A freshly reconstructed tracker starts every criterion as pending. That pending
      // placeholder must not erase a settled restored fact. A real result from this run
      // (satisfied/failed/unverifiable) is allowed to supersede the restored condition.
      if (restored && condition.status === 'pending') continue;
      conditions.set(condition.id, condition);
    }
    for (const condition of options.additionalConditions ?? []) {
      conditions.set(condition.id, condition);
    }
    return new CompletionFactsView({
      conditions: [...conditions.values()],
      outcomes: state.operationOutcomes?.snapshot() ?? [],
      executionTask: state.taskState.snapshot(),
      continuationCount: state.completionGateContinuationCount,
      previousBlockingSignature: state.completionGateBlockingSignature,
    });
  }

  static fromCompletionSnapshot(
    completion: ProjectCheckpointCompletion,
  ): CompletionFactsView {
    return new CompletionFactsView({
      conditions: completion.conditions,
      outcomes: completion.operationOutcomes,
    });
  }

  static fromTaskSnapshot(task: TaskStateSnapshot): CompletionFactsView {
    return new CompletionFactsView({ executionTask: task });
  }

  requiredBlockers(scope?: string): CompletionCondition[] {
    return this.conditions
      .filter(condition => condition.required)
      .filter(condition => matchesConditionScope(condition, scope))
      .filter(condition => !this.isConditionSatisfied(condition))
      .map(cloneCondition);
  }

  latestFailure(scope?: string): OperationOutcome | undefined {
    const outcome = [...this.outcomes]
      .reverse()
      .find(item => item.status === 'failed' && matchesScope(item.scope, scope));
    return outcome ? cloneOutcome(outcome) : undefined;
  }

  verificationSignal(scope?: string): VerificationSignal {
    const scopedConditions = this.conditions.filter(condition =>
      scope ? matchesConditionScope(condition, scope) : isVerificationCondition(condition),
    );
    const required = scopedConditions.some(condition => condition.required);
    const evidenceRefs = [...new Set(scopedConditions.flatMap(condition => condition.evidenceRefs))];
    const verificationFailure = scope
      ? this.latestFailure(scope)
      : [...this.outcomes].reverse().find(item =>
          item.status === 'failed'
          && (item.toolName.includes('verification') || item.scope.includes('verification')),
        );

    if (
      scopedConditions.some(condition => condition.status === 'failed')
      || verificationFailure
    ) {
      return { status: 'failed', required, scope, evidenceRefs };
    }
    if (scopedConditions.some(condition => !this.isConditionSatisfied(condition))) {
      return { status: 'pending', required, scope, evidenceRefs };
    }
    if (scopedConditions.length > 0) {
      return { status: 'passed', required, scope, evidenceRefs };
    }
    return { status: 'not_required', required: false, scope, evidenceRefs: [] };
  }

  hasPendingOperation(scope?: string): boolean {
    return this.outcomes.some(item =>
      (item.status === 'pending' || item.status === 'awaiting_approval')
      && matchesScope(item.scope, scope),
    );
  }

  completionDecisionInput(
    input: Pick<CompletionGateInput, 'answerReady' | 'maxContinuations'> = {},
  ): CompletionGateInput {
    const ledger = new OperationOutcomeLedger();
    ledger.replace(this.outcomes);
    return {
      conditions: this.conditions.map(cloneCondition),
      ledger,
      ...this.control,
      ...input,
    };
  }

  conditionSnapshot(): CompletionCondition[] {
    return this.conditions.map(cloneCondition);
  }

  operationSnapshot(): OperationOutcome[] {
    return this.outcomes.map(cloneOutcome);
  }

  executionTaskSnapshot(): TaskStateSnapshot | undefined {
    return this.executionTask
      ? {
          ...this.executionTask,
          filesRead: [...this.executionTask.filesRead],
          filesChanged: [...this.executionTask.filesChanged],
          commandsRun: [...this.executionTask.commandsRun],
        }
      : undefined;
  }

  private isConditionSatisfied(condition: CompletionCondition): boolean {
    if (condition.status !== 'satisfied' || condition.evidenceRefs.length === 0) return false;
    return condition.evidenceRefs.some(reference =>
      this.outcomes.some(outcome =>
        outcome.toolCallId === reference && outcome.status === 'completed',
      ),
    );
  }
}
function cloneTaskSnapshot(task: TaskStateSnapshot): TaskStateSnapshot {
  return {
    ...task,
    filesRead: [...task.filesRead],
    filesChanged: [...task.filesChanged],
    commandsRun: [...task.commandsRun],
  };
}

function matchesConditionScope(condition: CompletionCondition, scope?: string): boolean {
  if (!scope) return true;
  return matchesScope(condition.id, scope) || matchesScope(condition.sourceRef, scope);
}

function isVerificationCondition(condition: CompletionCondition): boolean {
  const key = `${condition.id}\n${condition.sourceRef}`.toLowerCase();
  return /(?:^|[:/])(acceptance|verification|verify|test)(?:[:/]|$)/.test(key);
}

function matchesScope(value: string, scope?: string): boolean {
  return !scope || value === scope || value.startsWith(`${scope}:`);
}

function cloneCondition(condition: CompletionCondition): CompletionCondition {
  return { ...condition, evidenceRefs: [...condition.evidenceRefs] };
}

function cloneOutcome(outcome: OperationOutcome): OperationOutcome {
  return {
    ...outcome,
    ...(outcome.receipt ? { receipt: { ...outcome.receipt } } : {}),
  };
}
