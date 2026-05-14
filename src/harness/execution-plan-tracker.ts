/**
 * ExecutionPlanTracker — 运行时 plan 状态机。
 *
 * 职责：
 *   1. 持有当前 plan，订阅 phase / tool_result / verification / stopReason 等信号。
 *   2. 计算 step 状态转移与 progress，生成最小 diff 的 patch。
 *   3. 通过注入的 emit 回调把事件推给前端（最终经 Harness onStep 走 WebSocket）。
 *
 * 关键不变量：
 *   - tracker 永远不拒绝模型的实际 toolCall（plan 仅是引导）。
 *   - 同一 step 状态相同的连续 patch 会被合并；空 patch 不发。
 *   - phase 跳级时把所有未到达的前置 step 自动 done（容错）。
 *
 * 设计文档：docs/execution-transparency-layer.md §Runtime Flow / §Risks
 */

import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import type {
  TaskPhase,
  TaskStateSnapshot,
  RepoContextSnapshot,
} from '../types/runtime-snapshot.js';
import type {
  ExecutionPlan,
  ExecutionPlanEvent,
  ExecutionPlanPatch,
  ExecutionStep,
  ExecutionStepPatch,
  ExecutionStepStatus,
} from '../types/execution-plan.js';
import { calcProgress } from './execution-plan-generator.js';
import type { StopReason } from './types.js';

const PHASE_ORDER: TaskPhase[] = ['intent', 'context', 'editing', 'verification', 'final'];

/** 同签名连续失败 N 次时把当前 step 标记为 failed */
const REPEATED_FAILURE_THRESHOLD = 2;

/** Tracker 对外发布事件的回调类型 */
export type ExecutionPlanEventEmitter = (event: ExecutionPlanEvent) => void;

export interface ExecutionPlanTrackerOptions {
  /** Tracker 启动时使用的初始 plan */
  plan: ExecutionPlan;
  /** 事件发射器（由 Harness 接到 onStep） */
  emit: ExecutionPlanEventEmitter;
  /** 时间戳注入（测试可控） */
  now?: () => number;
  /** 立即发布一个 execution_plan_init 事件（默认 true） */
  emitInit?: boolean;
}

export class ExecutionPlanTracker {
  private plan: ExecutionPlan;
  private readonly emit: ExecutionPlanEventEmitter;
  private readonly now: () => number;
  /** 同签名工具失败计数 */
  private readonly failureCounts = new Map<string, number>();
  /** 当前 step 累计的连续失败签名计数 */
  private currentStepFailureSignatures = new Set<string>();

  constructor(opts: ExecutionPlanTrackerOptions) {
    this.plan = clonePlan(opts.plan);
    this.emit = opts.emit;
    this.now = opts.now ?? (() => Date.now());

    if (opts.emitInit !== false) {
      this.emit({ type: 'execution_plan_init', plan: clonePlan(this.plan) });
    }
  }

  /** 暴露当前 plan 的只读副本（用于持久化 / REST 端点） */
  getPlan(): ExecutionPlan {
    return clonePlan(this.plan);
  }

  /** 重置 plan（任务切换时使用） */
  resetPlan(plan: ExecutionPlan): void {
    this.plan = clonePlan(plan);
    this.failureCounts.clear();
    this.currentStepFailureSignatures.clear();
    this.emit({ type: 'execution_plan_init', plan: clonePlan(this.plan) });
  }

  /**
   * 当 TaskState.phase 切换时调用：把第一个匹配该 phase 的 pending step 推进到 running。
   * 同时把所有更早 phase 的 pending step 自动 done（phase 跳级容错）。
   */
  onPhaseAdvance(newPhase: TaskPhase): void {
    const phaseIdx = PHASE_ORDER.indexOf(newPhase);
    if (phaseIdx < 0) return;

    const stepPatches: ExecutionStepPatch[] = [];
    let newActiveId: string | undefined = this.plan.activeStepId;
    const now = this.now();

    for (const step of this.plan.steps) {
      const stepPhaseIdx = PHASE_ORDER.indexOf(step.phase);

      // 更早阶段还在 pending/running 的 step → done（跳级容错）
      if (stepPhaseIdx >= 0 && stepPhaseIdx < phaseIdx) {
        if (step.status === 'pending' || step.status === 'running') {
          step.status = 'done';
          step.startedAt = step.startedAt ?? now;
          step.endedAt = now;
          stepPatches.push({
            id: step.id,
            status: 'done',
            startedAt: step.startedAt,
            endedAt: now,
          });
          if (newActiveId === step.id) newActiveId = undefined;
        }
        continue;
      }

      // 当前阶段对应的 step（只激活第一个 pending）
      if (stepPhaseIdx === phaseIdx && step.status === 'pending') {
        step.status = 'running';
        step.startedAt = now;
        stepPatches.push({ id: step.id, status: 'running', startedAt: now });
        newActiveId = step.id;
        this.currentStepFailureSignatures = new Set();
        // 只激活第一个匹配的，剩余同 phase 的步骤保持 pending
        break;
      }
    }

    this.maybeEmitUpdate({ stepPatches, newActiveId });
  }

  /**
   * 工具调用执行完成时调用。
   * - 成功：尝试把 evidence 写到当前 running step；若工具是验证类型且 verification 已通过，立即推进。
   * - 失败：累计签名计数；同签名 ≥ 阈值时把当前 step 标记 failed。
   */
  onToolResult(
    toolCall: ToolCall,
    result: ToolResult,
    taskSnapshot: TaskStateSnapshot,
    repoSnapshot: RepoContextSnapshot,
  ): void {
    // 先确保 plan 已对齐到当前 phase
    this.onPhaseAdvance(taskSnapshot.phase);

    const active = this.activeStep();
    const stepPatches: ExecutionStepPatch[] = [];

    if (active) {
      if (result.success) {
        const evidence = pickEvidence(toolCall, taskSnapshot, repoSnapshot);
        if (evidence && active.evidence !== evidence) {
          active.evidence = evidence;
          stepPatches.push({ id: active.id, evidence });
        }
      } else {
        const sig = `${toolCall.name}:${JSON.stringify(toolCall.arguments ?? {})}`;
        const next = (this.failureCounts.get(sig) ?? 0) + 1;
        this.failureCounts.set(sig, next);
        this.currentStepFailureSignatures.add(sig);
        if (next >= REPEATED_FAILURE_THRESHOLD && active.status === 'running') {
          active.status = 'failed';
          active.error = result.error?.slice(0, 240) ?? 'repeated tool failure';
          active.endedAt = this.now();
          stepPatches.push({
            id: active.id,
            status: 'failed',
            error: active.error,
            endedAt: active.endedAt,
          });
        }
      }
    }

    // 验证已通过 → 把验证 step 推到 done
    if (taskSnapshot.verificationStatus === 'passed') {
      for (const s of this.plan.steps) {
        if (s.isVerification && s.status !== 'done') {
          s.status = 'done';
          s.endedAt = this.now();
          stepPatches.push({ id: s.id, status: 'done', endedAt: s.endedAt });
        }
      }
    }

    this.maybeEmitUpdate({ stepPatches });
  }

  /**
   * 验证被要求（modelhas changed files but not verified yet）时调用。
   * 把第一个 isVerification 的 step 提前到 running。
   */
  onVerificationRequired(): void {
    const stepPatches: ExecutionStepPatch[] = [];
    let newActiveId = this.plan.activeStepId;
    const now = this.now();
    for (const s of this.plan.steps) {
      if (s.isVerification && s.status === 'pending') {
        s.status = 'running';
        s.startedAt = now;
        stepPatches.push({ id: s.id, status: 'running', startedAt: now });
        newActiveId = s.id;
        break;
      }
    }
    this.maybeEmitUpdate({ stepPatches, newActiveId });
  }

  /**
   * 任务最终结束（无论原因）。
   * - model_done：余下 pending 全部 skipped。
   * - error / circuit_breaker / user_abort / token_budget：保留 running 状态供下次恢复。
   */
  onFinal(stopReason: StopReason): void {
    const stepPatches: ExecutionStepPatch[] = [];
    const now = this.now();

    if (stopReason === 'model_done') {
      for (const s of this.plan.steps) {
        if (s.status === 'pending') {
          s.status = 'skipped';
          s.endedAt = now;
          stepPatches.push({ id: s.id, status: 'skipped', endedAt: now });
        } else if (s.status === 'running') {
          s.status = 'done';
          s.endedAt = now;
          stepPatches.push({ id: s.id, status: 'done', endedAt: now });
        }
      }
      this.maybeEmitUpdate({ stepPatches, newActiveId: undefined });
    } else {
      // 非正常完成：只刷新 updatedAt + progress 让前端展示「停在此处」
      this.maybeEmitUpdate({ stepPatches });
    }
  }

  // ─── 内部 ───

  private activeStep(): ExecutionStep | undefined {
    if (!this.plan.activeStepId) {
      return this.plan.steps.find(s => s.status === 'running');
    }
    return this.plan.steps.find(s => s.id === this.plan.activeStepId);
  }

  /**
   * 合并 step patches、刷新 progress、决定是否发事件。
   * 空 patch（无任何字段变化）会被丢弃，避免事件泛滥。
   */
  private maybeEmitUpdate(args: {
    stepPatches: ExecutionStepPatch[];
    newActiveId?: string;
  }): void {
    const dedupedPatches = mergeStepPatches(args.stepPatches);
    const newActive = args.newActiveId !== undefined
      ? args.newActiveId
      : recomputeActiveId(this.plan.steps);
    const newProgress = calcProgress(this.plan.steps);

    const activeChanged = newActive !== this.plan.activeStepId;
    const progressChanged = newProgress !== this.plan.progress;
    const hasStepChange = dedupedPatches.length > 0;

    if (!activeChanged && !progressChanged && !hasStepChange) {
      return;
    }

    this.plan.activeStepId = newActive;
    this.plan.progress = newProgress;
    this.plan.updatedAt = this.now();

    const patch: ExecutionPlanPatch = {
      stepPatches: dedupedPatches,
      updatedAt: this.plan.updatedAt,
      ...(activeChanged ? { activeStepId: newActive ?? '' } : {}),
      ...(progressChanged ? { progress: newProgress } : {}),
    };

    this.emit({
      type: 'execution_plan_update',
      planId: this.plan.planId,
      patch,
    });
  }
}

/**
 * 同 id 的多条 patch 合并为一条（保留最后的非 undefined 字段）。
 */
function mergeStepPatches(patches: ExecutionStepPatch[]): ExecutionStepPatch[] {
  const map = new Map<string, ExecutionStepPatch>();
  for (const p of patches) {
    const existing = map.get(p.id) ?? { id: p.id };
    map.set(p.id, { ...existing, ...stripUndefined(p) });
  }
  return [...map.values()];
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj) as Array<keyof T & string>) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function recomputeActiveId(steps: ExecutionStep[]): string | undefined {
  return steps.find(s => s.status === 'running')?.id;
}

function clonePlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map(s => ({ ...s, suggestedTools: s.suggestedTools ? [...s.suggestedTools] : undefined })),
  };
}

function pickEvidence(
  toolCall: ToolCall,
  taskSnapshot: TaskStateSnapshot,
  repoSnapshot: RepoContextSnapshot,
): string | undefined {
  // 路径类参数
  const args = toolCall.arguments ?? {};
  for (const key of ['path', 'filePath', 'file_path', 'target_file', 'targetFile']) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // 命令类参数
  if (typeof args.command === 'string' && args.command.trim()) {
    return args.command.trim().slice(0, 120);
  }
  // 退化：repoContext 最近条目
  const lastTest = repoSnapshot.testCommands.at(-1);
  if (lastTest) return lastTest;
  const lastFile = repoSnapshot.filesChanged.at(-1) ?? repoSnapshot.filesRead.at(-1);
  if (lastFile) return lastFile;
  const lastCmd = repoSnapshot.commandsRun.at(-1);
  if (lastCmd) return lastCmd;
  // 兜底：taskSnapshot
  return taskSnapshot.filesChanged.at(-1) ?? taskSnapshot.filesRead.at(-1);
}

export const __testing = {
  REPEATED_FAILURE_THRESHOLD,
  mergeStepPatches,
  recomputeActiveId,
};

// 保持外部对 ExecutionStepStatus 的类型可见
export type { ExecutionStepStatus };
