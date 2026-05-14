/**
 * Execution Transparency Layer 的共享数据模型。
 *
 * 与 runtime-snapshot.ts 平行：被 harness（生成 / 追踪）与 memory（持久化 fence）共用，
 * 同时通过 HarnessStepEvent.type 暴露给前端。
 *
 * 设计文档：docs/execution-transparency-layer.md
 */

import type { TaskIntent, TaskPhase } from './runtime-snapshot.js';

/** Plan schema 版本号；与 PERSIST_RUNTIME_SCHEMA_VERSION 平行演进 */
export const PERSIST_PLAN_SCHEMA_VERSION = 1 as const;

/** 单个步骤的运行时状态 */
export type ExecutionStepStatus =
  | 'pending'    // 未开始
  | 'running'    // 当前活动
  | 'done'       // 已完成
  | 'failed'     // 步骤期望的动作失败（如 verification 失败）
  | 'skipped';   // 用户/模型显式跳过 / 与新意图无关

/** 单个步骤 */
export interface ExecutionStep {
  /** 稳定 ID（plan 内唯一）。形如 step-01、step-02 */
  id: string;
  /** 给用户看的一行短描述（中文，<= 40 字） */
  title: string;
  /** 关联到的任务阶段；用于 tracker 用 TaskPhase 推动 */
  phase: TaskPhase;
  /** 可选：建议的工具名（来源 INTENT_TOOL_SUGGESTIONS） */
  suggestedTools?: string[];
  /** 该 step 是否需要工具调用支撑（仅展示提示） */
  requiresTool: boolean;
  /** 是否对应「验证」步骤（影响完成阈值与表情映射） */
  isVerification?: boolean;
  /** 当前状态；初始为 'pending' */
  status: ExecutionStepStatus;
  /** 进入 running 的 epoch ms（tracker 写入） */
  startedAt?: number;
  /** 进入终态的 epoch ms */
  endedAt?: number;
  /** 失败原因（status === 'failed' 时填） */
  error?: string;
  /** 关联证据：来自 RepoContext / TaskState 的最近一条命中（路径或命令） */
  evidence?: string;
}

/** 完整执行计划 */
export interface ExecutionPlan {
  version: typeof PERSIST_PLAN_SCHEMA_VERSION;
  /** 与 Harness 同会话同任务的稳定 ID（首轮生成时定型） */
  planId: string;
  /** 原始用户目标，用于校验是否仍是同一任务（与 TaskState.goal 一致） */
  goal: string;
  /** 任务意图（与 TaskState.intent 一致） */
  intent: TaskIntent;
  steps: ExecutionStep[];
  /** 当前活动 step 的 id（恰有 0 或 1 个 running） */
  activeStepId?: string;
  /** 整体进度百分比（done / 总步数；skipped 也算分母；0-100 整数） */
  progress: number;
  /** 计划生成时间 */
  createdAt: number;
  /** 最近一次更新时间 */
  updatedAt: number;
}

/** 单条 step 的增量补丁（patch 内字段全部可选，仅传变化项） */
export interface ExecutionStepPatch {
  id: string;
  status?: ExecutionStepStatus;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  evidence?: string;
}

/** 整体 plan 的增量补丁 */
export interface ExecutionPlanPatch {
  activeStepId?: string;
  progress?: number;
  updatedAt: number;
  stepPatches: ExecutionStepPatch[];
}

/** 全量初始化事件 */
export interface ExecutionPlanInitEvent {
  type: 'execution_plan_init';
  plan: ExecutionPlan;
}

/** 增量更新事件 */
export interface ExecutionPlanUpdateEvent {
  type: 'execution_plan_update';
  planId: string;
  patch: ExecutionPlanPatch;
}

export type ExecutionPlanEvent = ExecutionPlanInitEvent | ExecutionPlanUpdateEvent;
