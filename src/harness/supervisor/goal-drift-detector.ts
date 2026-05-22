import { bigramJaccard } from '../harness-message-utils.js';
import type {
  DeviationSignal,
  GoalDriftConfig,
  SupervisorTriggers,
  TaskContext,
} from '../../types/supervisor.js';
import type { TaskIntent } from '../../types/runtime-snapshot.js';

/**
 * §8.3 / §19.1 — GoalDriftDetector V1 启发式实现。
 *
 * **边界（与规格一致）：**
 *   - 仅作为 `PassiveObserver` 等价的合成信号源，**不直接切换 executionMode（I5）**；
 *   - 由 `SupervisorRuntimeBridge` 在 evaluate 前调用，得到的 `goal_drift` signal 作为 §9 条件三之一；
 *   - 用户 goal 关键词 **禁止** 作为 Forced 触发源（V1 启发式只反向产 alignment 分）。
 *
 * **V1 启发式 alignment（0~1，越高越对齐）** 由四个因子加权（默认等权）求和：
 *   1. 工具与 intent 一致性（如 edit/refactor 出现大量 read_file → 衰减）；
 *   2. filesChanged 与 intent 的一致性（editing intent 但 filesChanged 为空 → 衰减）；
 *   3. 用户 goal 与 lastAssistantText 的 bigram Jaccard（复用 harness-message-utils）；
 *   4. 任务推进度（recentFailureCount / branchBudgetTriggers 高 → 衰减）。
 *
 * **连续 N 轮**（`consecutiveRoundsBelow`）低于 `alignmentThreshold` → 产 `goal_drift` signal。
 *
 * V2 LLM 灰区（`llmGrayZoneLow/High`）留待 M4 RiskEvaluator 介入；V1 仅启发式。
 */

export interface GoalDriftEvaluateInput {
  task: TaskContext;
  /** 本轮工具名集合（read_file / edit_file / run_command 等）。 */
  toolNames: string[];
  /** 本轮工具成功标志，与 toolNames 等长。 */
  toolSuccess: boolean[];
  /** 最近一条 assistant 文本（可选；用于 bigram Jaccard）。 */
  lastAssistantText?: string;
  /** 本轮是否包含写工具（edit_file / search_replace / write 等）。 */
  hadWriteTool: boolean;
}

export interface GoalDriftEvaluation {
  alignment: number;
  belowThresholdRoundsConsecutive: number;
  signal?: Extract<DeviationSignal, { type: 'goal_drift' }>;
  /** 启发式各分项中间值，便于 timeline / 调试输出。 */
  factors: {
    toolIntent: number;
    fileIntent: number;
    goalAssistantJaccard: number;
    progress: number;
  };
}

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'search',
  'list_dir',
  'codebase_search',
  'fetch_url',
  'web_search',
  'glob_file_search',
]);

const WRITE_TOOLS = new Set([
  'edit_file',
  'write',
  'str_replace',
  'apply_patch',
  'create_file',
  'search_replace',
]);

const EDITING_INTENTS: ReadonlySet<TaskIntent> = new Set([
  'edit',
  'debug',
  'refactor',
  'test',
]);

export class GoalDriftDetector {
  private readonly config: GoalDriftConfig;
  private readonly triggers: SupervisorTriggers;
  private belowStreak = 0;
  private readonly history: number[] = [];

  constructor(config: GoalDriftConfig, triggers: SupervisorTriggers) {
    this.config = config;
    this.triggers = triggers;
  }

  /** 启用与否：受 `triggers.goalDriftEnabled` 控制；off / 关闭时调用方应直接跳过本对象。 */
  isEnabled(): boolean {
    return this.triggers.goalDriftEnabled;
  }

  /**
   * 计算本轮 alignment，并按连续 N 轮规则决定是否发出 `goal_drift` signal。
   * **side effect：** 仅更新内部 streak 与 history；不写 timeline / msgs。
   */
  evaluate(input: GoalDriftEvaluateInput): GoalDriftEvaluation {
    if (!this.isEnabled()) {
      return {
        alignment: 1,
        belowThresholdRoundsConsecutive: 0,
        factors: { toolIntent: 1, fileIntent: 1, goalAssistantJaccard: 1, progress: 1 },
      };
    }

    const factors = this.computeFactors(input);
    const alignment = clamp01(
      (factors.toolIntent + factors.fileIntent + factors.goalAssistantJaccard + factors.progress) / 4,
    );

    this.history.push(alignment);
    if (this.history.length > 32) this.history.shift();

    const isBelow = alignment < this.config.alignmentThreshold;
    this.belowStreak = isBelow ? this.belowStreak + 1 : 0;

    const evaluation: GoalDriftEvaluation = {
      alignment,
      belowThresholdRoundsConsecutive: this.belowStreak,
      factors,
    };

    if (this.belowStreak >= this.config.consecutiveRoundsBelow) {
      evaluation.signal = { type: 'goal_drift', alignment };
    }

    return evaluation;
  }

  reset(): void {
    this.belowStreak = 0;
    this.history.length = 0;
  }

  /** 最近 N 轮 alignment 分数（LoopState `alignmentHistory` 用，见 §15.7）。 */
  getRecentHistory(limit = 8): number[] {
    if (limit >= this.history.length) return [...this.history];
    return this.history.slice(-limit);
  }

  // ---------------------- factor calculators ----------------------

  private computeFactors(input: GoalDriftEvaluateInput): GoalDriftEvaluation['factors'] {
    return {
      toolIntent: this.toolIntentAlignment(input),
      fileIntent: this.fileIntentAlignment(input),
      goalAssistantJaccard: this.goalAssistantJaccard(input),
      progress: this.progressAlignment(input),
    };
  }

  private toolIntentAlignment(input: GoalDriftEvaluateInput): number {
    const tools = input.toolNames;
    if (tools.length === 0) return 1;

    const readOnlyShare = countShare(tools, t => READ_ONLY_TOOLS.has(t));
    const writeShare = countShare(tools, t => WRITE_TOOLS.has(t));

    const editing = EDITING_INTENTS.has(input.task.intent);
    if (editing) {
      // editing intent 但全是只读工具 → 漂移；写工具占比越高越对齐。
      if (writeShare === 0 && readOnlyShare > 0.6) return 0.2;
      return clamp01(0.4 + writeShare * 0.6);
    }

    // inspect / question / docs：只读工具占比越高越对齐。
    if (input.task.intent === 'inspect' || input.task.intent === 'question' || input.task.intent === 'docs') {
      return clamp01(0.4 + readOnlyShare * 0.6);
    }

    return 0.8;
  }

  private fileIntentAlignment(input: GoalDriftEvaluateInput): number {
    const editing = EDITING_INTENTS.has(input.task.intent);
    if (!editing) return 1;

    const hasWriteTool = input.hadWriteTool;
    const filesChangedCount = input.task.filesChanged.length;

    // §19.1 "filesChanged 为空但 phase 已进入 editing" → 明确的漂移信号。
    if (!hasWriteTool && filesChangedCount === 0) return 0.2;
    if (hasWriteTool && filesChangedCount === 0) return 0.3;
    return 1;
  }

  private goalAssistantJaccard(input: GoalDriftEvaluateInput): number {
    const goal = input.task.goal?.trim() ?? '';
    const last = input.lastAssistantText?.trim() ?? '';
    if (!goal || !last) return 0.3;

    const min = this.config.jaccardMinGoalOverlap ?? 0.05;
    const jaccard = bigramJaccard(goal, last);
    if (jaccard >= min) return clamp01(0.5 + jaccard * 2);
    return clamp01(jaccard * 5);
  }

  private progressAlignment(input: GoalDriftEvaluateInput): number {
    const failures = input.task.recentFailureCount;
    const branchTriggers = input.task.branchBudgetTriggers;
    const allFailed = input.toolNames.length > 0 && input.toolSuccess.every(s => !s);

    let score = 1;
    if (failures >= 3) score -= 0.4;
    else if (failures === 2) score -= 0.2;
    if (branchTriggers >= 2) score -= 0.2;
    if (allFailed) score -= 0.2;

    return clamp01(score);
  }
}

function countShare(values: string[], predicate: (v: string) => boolean): number {
  if (values.length === 0) return 0;
  let n = 0;
  for (const v of values) if (predicate(v)) n += 1;
  return n / values.length;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function createGoalDriftDetector(
  config: GoalDriftConfig,
  triggers: SupervisorTriggers,
): GoalDriftDetector {
  return new GoalDriftDetector(config, triggers);
}
