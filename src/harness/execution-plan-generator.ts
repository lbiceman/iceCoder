/**
 * ExecutionPlanGenerator — 由 goal + intent + TaskState 快照生成结构化执行计划。
 *
 * 纯函数：不接 LLM、不读盘、不发事件、不依赖 Harness 内部状态。
 * 设计文档：docs/execution-transparency-layer.md §Proposed Architecture / §Data Model
 */

import { randomUUID } from 'node:crypto';
import type {
  TaskIntent,
  TaskPhase,
  TaskStateSnapshot,
} from '../types/runtime-snapshot.js';
import {
  PERSIST_PLAN_SCHEMA_VERSION,
  type ExecutionPlan,
  type ExecutionStep,
} from '../types/execution-plan.js';
import { INTENT_TOOL_SUGGESTIONS } from './tool-plan-intent-map.js';

export interface ExecutionPlanGeneratorInput {
  goal: string;
  intent: TaskIntent;
  taskSnapshot?: TaskStateSnapshot;
  /** 注入时间戳（测试可控；默认 Date.now()） */
  now?: number;
  /** 注入 planId（测试可控；默认 randomUUID） */
  planId?: string;
}

/**
 * 由意图生成阶段模板（顺序就是执行顺序）。
 * 注意：每个意图至少有一个 phase=intent 的「确认任务」首步；
 * 「question」意图返回 null（不显示 plan 面板）。
 */
function templateForIntent(intent: TaskIntent): Array<Omit<ExecutionStep, 'id' | 'status'>> {
  switch (intent) {
    case 'edit':
      return [
        { title: '理解目标', phase: 'intent', requiresTool: false },
        { title: '阅读相关源文件', phase: 'context', requiresTool: true },
        { title: '修改对应代码', phase: 'editing', requiresTool: true },
        { title: '执行验证命令', phase: 'verification', requiresTool: true, isVerification: true },
        { title: '总结改动', phase: 'final', requiresTool: false },
      ];
    case 'debug':
      return [
        { title: '复现 / 解析错误', phase: 'intent', requiresTool: false },
        { title: '搜索并读取相关文件', phase: 'context', requiresTool: true },
        { title: '修复最小代码路径', phase: 'editing', requiresTool: true },
        { title: '运行重点测试或类型检查', phase: 'verification', requiresTool: true, isVerification: true },
        { title: '回报根因与改动', phase: 'final', requiresTool: false },
      ];
    case 'test':
      return [
        { title: '定位待跑测试', phase: 'intent', requiresTool: false },
        { title: '运行失败用例', phase: 'context', requiresTool: true },
        { title: '修代码或修测试', phase: 'editing', requiresTool: true },
        { title: '重跑聚焦测试', phase: 'verification', requiresTool: true, isVerification: true },
        { title: '汇报测试结果', phase: 'final', requiresTool: false },
      ];
    case 'refactor':
      return [
        { title: '梳理重构范围', phase: 'intent', requiresTool: false },
        { title: '检查引用 / 使用点', phase: 'context', requiresTool: true },
        { title: '批量应用变更', phase: 'editing', requiresTool: true },
        { title: '运行测试 / 类型检查', phase: 'verification', requiresTool: true, isVerification: true },
        { title: '总结重构影响', phase: 'final', requiresTool: false },
      ];
    case 'inspect':
      return [
        { title: '确认查阅范围', phase: 'intent', requiresTool: false },
        { title: '搜索或读取相关位置', phase: 'context', requiresTool: true },
        { title: '依据证据回答', phase: 'final', requiresTool: false },
      ];
    case 'docs':
      return [
        { title: '理解文档目标', phase: 'intent', requiresTool: false },
        { title: '查看现有文档与源码', phase: 'context', requiresTool: true },
        { title: '编写或更新文档', phase: 'editing', requiresTool: true },
        { title: '总结文档改动', phase: 'final', requiresTool: false },
      ];
    case 'question':
      // question 类不展示执行计划
      return [];
    default:
      return [];
  }
}

/**
 * 由 taskSnapshot 决定每个模板 step 的初始状态。
 *
 * 续聊场景下，若已经走到 `editing` 阶段，那么 `intent`/`context` step 直接初始化为 `done`，
 * 当前阶段对应 step 初始化为 `running`。
 */
function deriveInitialStatuses(
  template: Array<Omit<ExecutionStep, 'id' | 'status'>>,
  taskSnapshot: TaskStateSnapshot | undefined,
  now: number,
): { steps: ExecutionStep[]; activeStepId?: string } {
  const phase: TaskPhase = taskSnapshot?.phase ?? 'intent';
  const phaseOrder: TaskPhase[] = ['intent', 'context', 'editing', 'verification', 'final'];
  const currentIdx = phaseOrder.indexOf(phase);

  const steps: ExecutionStep[] = template.map((t, i) => {
    const id = `step-${String(i + 1).padStart(2, '0')}`;
    const tIdx = phaseOrder.indexOf(t.phase);
    if (tIdx < currentIdx) {
      return { ...t, id, status: 'done', startedAt: now, endedAt: now };
    }
    if (tIdx === currentIdx && tIdx >= 0) {
      return { ...t, id, status: 'running', startedAt: now };
    }
    return { ...t, id, status: 'pending' };
  });

  // 如果 snapshot 显示验证已通过，则把验证步骤置为 done
  if (taskSnapshot?.verificationStatus === 'passed') {
    for (const s of steps) {
      if (s.isVerification) {
        s.status = 'done';
        s.endedAt = now;
      }
    }
  }

  const active = steps.find(s => s.status === 'running');
  return { steps, activeStepId: active?.id };
}

/**
 * 计算 progress 百分比：已结束 step / 总步数。
 *
 * 已结束 = done + failed + skipped（不再变动的终态）；
 * pending / running 不计入分子。tracker 后续同步使用同一公式，保证前后端一致。
 */
export function calcProgress(steps: ExecutionStep[]): number {
  if (steps.length === 0) return 0;
  const finished = steps.filter(s =>
    s.status === 'done' || s.status === 'failed' || s.status === 'skipped',
  ).length;
  return Math.round((finished / steps.length) * 100);
}

/**
 * 注入意图建议的工具名到每个 step。
 * 仅给 requiresTool=true 的 step 写入，避免在「总结」类 step 上误导。
 */
function attachSuggestedTools(steps: ExecutionStep[], intent: TaskIntent): void {
  const suggestions = INTENT_TOOL_SUGGESTIONS[intent];
  if (!suggestions || suggestions.length === 0) return;
  for (const s of steps) {
    if (!s.requiresTool) continue;
    if (s.isVerification) {
      s.suggestedTools = ['run_command'];
    } else if (s.phase === 'context') {
      // context 阶段优先「读 / 搜索」类工具
      s.suggestedTools = suggestions.filter(t =>
        t === 'read_file'
        || t === 'search_codebase'
        || t === 'file_info',
      );
      if (s.suggestedTools.length === 0) s.suggestedTools = [...suggestions];
    } else if (s.phase === 'editing') {
      s.suggestedTools = suggestions.filter(t =>
        t === 'edit_file'
        || t === 'write_file'
        || t === 'patch_file'
        || t === 'batch_edit_file',
      );
      if (s.suggestedTools.length === 0) s.suggestedTools = [...suggestions];
    } else {
      s.suggestedTools = [...suggestions];
    }
  }
}

/**
 * 构建执行计划。
 *
 * @returns 完整 ExecutionPlan；若意图不适合展示 plan（如 question / 空 goal），返回 null。
 */
export function buildExecutionPlan(input: ExecutionPlanGeneratorInput): ExecutionPlan | null {
  const goal = (input.goal ?? '').trim();
  if (!goal) return null;
  const intent = input.intent;
  const template = templateForIntent(intent);
  if (template.length === 0) return null;

  const now = input.now ?? Date.now();
  const planId = input.planId ?? randomUUID();

  const { steps, activeStepId } = deriveInitialStatuses(template, input.taskSnapshot, now);
  attachSuggestedTools(steps, intent);

  return {
    version: PERSIST_PLAN_SCHEMA_VERSION,
    planId,
    goal,
    intent,
    steps,
    activeStepId,
    progress: calcProgress(steps),
    createdAt: now,
    updatedAt: now,
  };
}
