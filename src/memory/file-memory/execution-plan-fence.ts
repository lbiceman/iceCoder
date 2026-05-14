/**
 * session-notes.md 中持久化执行计划的 fence 读写。
 *
 * 与 `icecoder-runtime` fence 完全独立：
 *   - 版本号、字段、解析逻辑分开演进；
 *   - 解析时取最后一个 fence（支持多次写入累加，恢复时拿到最新状态）。
 *
 * 设计文档：docs/execution-transparency-layer.md §Session Recovery
 */

import {
  PERSIST_PLAN_SCHEMA_VERSION,
  type ExecutionPlan,
  type ExecutionStep,
  type ExecutionStepStatus,
} from '../../types/execution-plan.js';
import type { TaskIntent, TaskPhase } from '../../types/runtime-snapshot.js';

/** fenced code block 语言标记 */
export const ICECODER_PLAN_FENCE_LANG = 'icecoder-plan';

const TASK_INTENTS = new Set<string>([
  'question', 'inspect', 'edit', 'debug', 'test', 'refactor', 'docs',
]);
const TASK_PHASES = new Set<string>(['intent', 'context', 'editing', 'verification', 'final']);
const STEP_STATUSES = new Set<string>(['pending', 'running', 'done', 'failed', 'skipped']);

/**
 * 序列化 plan 为单行 JSON 字符串（外层调用方负责再包 fence）。
 */
export function serializePersistedPlan(plan: ExecutionPlan): string {
  return JSON.stringify(plan);
}

/**
 * 把 plan 序列化为完整的 fenced block 文本（直接拼到 session-notes 末尾即可）。
 */
export function buildPlanFence(plan: ExecutionPlan): string {
  return [
    `\`\`\`${ICECODER_PLAN_FENCE_LANG}`,
    serializePersistedPlan(plan),
    '```',
  ].join('\n');
}

/**
 * 从 session-notes 全文解析最近一次写入的 plan（取最后一个 fence）。
 *
 * 不通过校验时返回 `null`（包括版本不匹配、字段类型错误、未知 enum 值等）。
 */
export function parsePersistedPlan(notes: string): ExecutionPlan | null {
  const open = `\`\`\`${ICECODER_PLAN_FENCE_LANG}`;
  const idx = notes.lastIndexOf(open);
  if (idx === -1) return null;
  const start = idx + open.length;
  const close = notes.indexOf('```', start);
  if (close === -1) return null;
  const raw = notes.slice(start, close).trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const o = parsed as Record<string, unknown>;
  if (o.version !== PERSIST_PLAN_SCHEMA_VERSION) return null;
  if (typeof o.planId !== 'string' || !o.planId.trim()) return null;
  if (typeof o.goal !== 'string') return null;
  if (typeof o.intent !== 'string' || !TASK_INTENTS.has(o.intent)) return null;
  if (typeof o.progress !== 'number' || !Number.isFinite(o.progress)) return null;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return null;
  if (typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) return null;
  if (!Array.isArray(o.steps)) return null;

  const steps: ExecutionStep[] = [];
  for (const rawStep of o.steps) {
    const step = sanitizeStep(rawStep);
    if (!step) return null;
    steps.push(step);
  }

  if (o.activeStepId !== undefined && typeof o.activeStepId !== 'string') return null;
  const activeStepId = typeof o.activeStepId === 'string' && o.activeStepId
    ? o.activeStepId
    : undefined;
  if (activeStepId && !steps.some(s => s.id === activeStepId)) return null;

  return {
    version: PERSIST_PLAN_SCHEMA_VERSION,
    planId: o.planId,
    goal: o.goal,
    intent: o.intent as TaskIntent,
    steps,
    activeStepId,
    progress: Math.max(0, Math.min(100, Math.round(o.progress))),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function sanitizeStep(raw: unknown): ExecutionStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id.trim()) return null;
  if (typeof s.title !== 'string') return null;
  if (typeof s.phase !== 'string' || !TASK_PHASES.has(s.phase)) return null;
  if (typeof s.status !== 'string' || !STEP_STATUSES.has(s.status)) return null;
  if (typeof s.requiresTool !== 'boolean') return null;

  const out: ExecutionStep = {
    id: s.id,
    title: s.title,
    phase: s.phase as TaskPhase,
    requiresTool: s.requiresTool,
    status: s.status as ExecutionStepStatus,
  };

  if (Array.isArray(s.suggestedTools)) {
    out.suggestedTools = s.suggestedTools.filter((x): x is string => typeof x === 'string');
  }
  if (s.isVerification === true) out.isVerification = true;
  if (typeof s.startedAt === 'number' && Number.isFinite(s.startedAt)) out.startedAt = s.startedAt;
  if (typeof s.endedAt === 'number' && Number.isFinite(s.endedAt)) out.endedAt = s.endedAt;
  if (typeof s.error === 'string') out.error = s.error;
  if (typeof s.evidence === 'string') out.evidence = s.evidence;
  return out;
}
