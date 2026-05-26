import type {
  DeviationSignal,
  RuntimeRound,
  SupervisorPhase,
  SupervisorTriggers,
} from '../../types/supervisor.js';

/** §8.2 — 单轮观察输入（由 Harness 工具轮末段组装）。 */
export interface PassiveObserveInput {
  phase: SupervisorPhase;
  round: RuntimeRound;
  consecutiveToolFailures: number;
  consecutiveReadOnlyRounds: number;
  /** 连续无 toolCalls 的 LLM 轮（model 空转）。 */
  consecutiveNoToolRounds?: number;
  stableRoundsSinceLastFailure: number;
  allToolsFailedThisRound: boolean;
  /** 本轮检测到的「同参重复失败」工具签名。 */
  repeatedToolSignatures: string[];
  /** `failedToolCallSignatures` 中的最大累计次数。 */
  maxFailedSignatureCount: number;
  /** 分支预算：单文件最高编辑次数（用于 file_loop）。 */
  topFileEdit?: { path: string; count: number };
  /** 本轮 branch budget 是否已触发恢复判定。 */
  branchRecoverTriggered: boolean;
}

/**
 * §8.2 PassiveObserver — 后台采集偏离信号，不干预执行、不写 msgs。
 * 累积信号供 RecoverySupervisor.evaluate（L2-3）消费。
 */
export class PassiveObserver {
  private readonly triggers: SupervisorTriggers;
  private accumulated: DeviationSignal[] = [];

  constructor(triggers: SupervisorTriggers) {
    this.triggers = triggers;
  }

  /** 分析本轮工具结果，返回本轮新增信号并写入内部累积列表。 */
  observe(input: PassiveObserveInput): DeviationSignal[] {
    const roundSignals: DeviationSignal[] = [];

    const thisRoundHasRepeatFailure =
      input.repeatedToolSignatures.length > 0
      || input.allToolsFailedThisRound
      || input.branchRecoverTriggered;

    const repeatCount = thisRoundHasRepeatFailure
      ? Math.max(
        input.maxFailedSignatureCount,
        input.repeatedToolSignatures.length,
        input.branchRecoverTriggered ? 1 : 0,
      )
      : 0;
    if (repeatCount >= this.triggers.toolRepeatFailMin) {
      roundSignals.push({ type: 'tool_repeat_fail', count: repeatCount });
    }

    const noProgressRounds = Math.max(
      input.consecutiveReadOnlyRounds,
      input.consecutiveNoToolRounds ?? 0,
      input.allToolsFailedThisRound ? input.consecutiveToolFailures : 0,
    );
    if (noProgressRounds >= this.triggers.noProgressRoundsMin) {
      roundSignals.push({ type: 'no_progress', rounds: noProgressRounds });
    }

    if (input.topFileEdit && input.topFileEdit.count >= this.triggers.fileLoopMin) {
      roundSignals.push({
        type: 'file_loop',
        path: input.topFileEdit.path,
        count: input.topFileEdit.count,
      });
    }

    if (roundSignals.length > 0) {
      this.accumulated.push(...roundSignals);
    }

    return roundSignals;
  }

  getAccumulated(): readonly DeviationSignal[] {
    return [...this.accumulated];
  }

  /**
   * L2-4：外部模块（GoalDriftDetector / scope_creep / user_force_takeover）提交 signal。
   * `triggers` toggle 关闭时直接丢弃（保持 §15.4 配置语义）。
   * 返回是否成功累积。
   */
  pushSignal(signal: DeviationSignal): boolean {
    if (!this.isTriggerEnabled(signal)) return false;
    this.accumulated.push(signal);
    return true;
  }

  reset(): void {
    this.accumulated = [];
  }

  private isTriggerEnabled(signal: DeviationSignal): boolean {
    switch (signal.type) {
      case 'goal_drift':
        return this.triggers.goalDriftEnabled;
      case 'scope_creep':
        return this.triggers.scopeCreepEnabled;
      case 'user_force_takeover':
        return this.triggers.userForceTakeoverEnabled;
      case 'tool_repeat_fail':
      case 'no_progress':
      case 'file_loop':
        return true;
    }
  }
}

export function formatDeviationSignalReason(signal: DeviationSignal): string {
  switch (signal.type) {
    case 'tool_repeat_fail':
      return `tool_repeat_fail:${signal.count}`;
    case 'no_progress':
      return `no_progress:${signal.rounds}`;
    case 'file_loop':
      return `file_loop:${signal.path}:${signal.count}`;
    case 'goal_drift':
      return `goal_drift:${signal.alignment}`;
    case 'scope_creep':
      return 'scope_creep';
    case 'user_force_takeover':
      return 'user_force_takeover';
  }
}

export function topFileEditFromInspect(
  fileEdits: Record<string, number>,
): { path: string; count: number } | undefined {
  let top: { path: string; count: number } | undefined;
  for (const [path, count] of Object.entries(fileEdits)) {
    if (!top || count > top.count) {
      top = { path, count };
    }
  }
  return top;
}

export function maxFailedSignatureCount(signatures: Map<string, number>): number {
  let max = 0;
  for (const count of signatures.values()) {
    if (count > max) max = count;
  }
  return max;
}
