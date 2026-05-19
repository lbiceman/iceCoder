/**
 * TaskGraphView — 前端展示用的 TaskGraph 视图模型（Phase 13）。
 *
 * 替代原先从 execution-plan.ts 引入的 ExecutionPlan / ExecutionPlanPatch 类型，
 * 供 HarnessStepEvent.plan / .patch 字段使用（仅前端消费）。
 */

/** 单个节点的运行时状态 */
export type TaskGraphNodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'fallback';

/** 前端展示用的单个节点视图 */
export interface TaskGraphNodeView {
  /** 稳定 ID */
  id: string;
  /** 短描述 */
  title: string;
  /** 关联阶段 */
  phase: string;
  /** 建议工具（可选） */
  suggestedTools?: string[];
  /** 是否需要工具 */
  requiresTool: boolean;
  /** 是否验证步骤 */
  isVerification?: boolean;
  /** 当前状态 */
  status: TaskGraphNodeStatus;
  /** 进入 running 的时间 */
  startedAt?: number;
  /** 进入终态的时间 */
  endedAt?: number;
  /** 失败原因 */
  error?: string;
  /** 关联证据 */
  evidence?: string;
}

/** 完整 TaskGraph 的只读视图（供前端 init 事件使用） */
export interface TaskGraphView {
  /** 与 TaskGraph 同会话的稳定 ID */
  planId: string;
  /** 用户目标 */
  goal: string;
  /** 任务意图 */
  intent: string;
  /** 节点列表 */
  steps: TaskGraphNodeView[];
  /** 当前活动节点 ID */
  activeStepId?: string;
  /** 整体进度 (0-100) */
  progress: number;
  /** 生成时间 */
  createdAt: number;
  /** 最近更新时间 */
  updatedAt: number;
}

/** 单节点增量更新 */
export interface TaskGraphNodePatch {
  id: string;
  status?: TaskGraphNodeStatus;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  evidence?: string;
}

/** 整体图增量更新（供前端 update 事件使用） */
export interface TaskGraphPatch {
  activeStepId?: string;
  progress?: number;
  updatedAt: number;
  stepPatches: TaskGraphNodePatch[];
}
