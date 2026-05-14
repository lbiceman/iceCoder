/**
 * StepReview — 运行时步骤回顾。
 *
 * 目的：每次执行步骤完成 / 工具失败 / 验证失败后，
 * 评估「这一步是否取得了进展」「是否在重复同样的动作」，
 * 必要时建议 fallback。
 *
 * 内部控制信号，不暴露给用户。
 *
 * 实现策略：
 *   1. 先用纯本地启发式判断（O(1)，零成本）；
 *      足够明显的"重复同一动作 / 同一错误"无需 LLM 就能识别。
 *   2. 仅在启发式无法定论时，调用一次轻量 LLM（max 1 small completion）。
 *   3. LLM 调用失败 / 未注入时优雅降级为启发式结果。
 *
 * 触发器（由 Harness 调用方决定）：
 *   - step transition
 *   - tool failure
 *   - verification failure
 *
 * 不在每轮调用。
 *
 * 设计文档：docs/长时间连续工作.md §Part 1
 */

import type { ChatFunction } from './types.js';
import type { UnifiedMessage } from '../llm/types.js';
import type { TaskStateSnapshot } from '../types/runtime-snapshot.js';

/** StepReview 输出结果 */
export interface StepReviewResult {
  /** 是否取得了进展（例如新读到 / 写入了文件，或验证通过等） */
  progressMade: boolean;
  /** 是否在重复同一动作（相同工具签名连续失败、文件反复编辑） */
  repeatedPattern: boolean;
  /** 是否建议切换策略 / fallback */
  fallbackSuggested: boolean;
  /** 简短判断理由（用于日志 / 注入提示） */
  reason: string;
  /** 评估来源：本地启发式 / LLM */
  source: 'heuristic' | 'llm';
}

/** StepReview 触发源 */
export type StepReviewTrigger =
  | 'step_transition'
  | 'tool_failure'
  | 'verification_failure';

/** 单个工具调用的简化轨迹（StepReview 输入） */
export interface ReviewToolTrace {
  toolName: string;
  /** 调用签名（toolName + args 摘要） */
  signature: string;
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
}

/** StepReview 调用上下文（必须 minimal） */
export interface StepReviewContext {
  /** 任务目标，对应 TaskState.goal */
  goal: string;
  /** 当前步骤标题或描述（来自 ExecutionPlan.activeStep.title 或 phase） */
  currentStep?: string;
  /** 最近几次工具调用轨迹（最多 5 条） */
  recentTools: ReviewToolTrace[];
  /** 最近几条错误信息（最多 3 条） */
  lastErrors: string[];
  /** 触发源 */
  trigger: StepReviewTrigger;
  /** 任务快照（用于推断 progress） */
  taskSnapshot?: TaskStateSnapshot;
  /** 前一轮 review 结果（如有），用于"连续两次仍无进展" 的判断 */
  previousReview?: StepReviewResult;
}

/**
 * 上下文裁剪上限。Step review 必须 bounded —
 * 不能因为长任务导致 prompt 越来越大。
 */
const MAX_RECENT_TOOLS = 5;
const MAX_LAST_ERRORS = 3;
const MAX_ERROR_LENGTH = 240;

/** 主入口：评估当前步骤。 */
export async function reviewStep(
  context: StepReviewContext,
  chatFn?: ChatFunction,
): Promise<StepReviewResult> {
  const trimmed = trimContext(context);

  const heuristic = heuristicReview(trimmed);

  // 1) 启发式给出非常明确的结论（明显的重复 / 明显的进展）→ 直接返回
  if (heuristic.confident) {
    return heuristic.result;
  }

  // 2) 模糊情况下，如果有 LLM 注入则做一次轻量调用
  if (chatFn) {
    try {
      const llmResult = await llmReview(trimmed, chatFn);
      if (llmResult) return llmResult;
    } catch (err) {
      // LLM 调用失败 — 优雅降级到启发式结果，不抛
      console.debug(
        '[step-review] LLM 调用失败，降级到启发式: ',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 3) 兜底
  return heuristic.result;
}

/**
 * 启发式判断（纯本地，零成本）。
 *
 * 规则（顺序敏感）：
 *   - 最近 N 次工具同签名失败 ≥ 2 → repeatedPattern=true, fallbackSuggested=true
 *   - trigger === verification_failure → 专用理由（优先于「全部失败」泛化分支）
 *   - 最近 N 次工具全部失败 → fallbackSuggested=true
 *   - 验证已通过 / 有文件变更且有成功工具 —— 若 verificationStatus === 'failed' 则不判为进展
 */
function heuristicReview(ctx: StepReviewContext): {
  result: StepReviewResult;
  /** 是否对结论非常确定（用以决定是否还需要走 LLM） */
  confident: boolean;
} {
  const recent = ctx.recentTools;
  const hadAnySuccess = recent.some(t => t.success);
  const hadAnyFailure = recent.some(t => !t.success);

  // 1. 同签名连续失败
  const sigCounts = new Map<string, number>();
  for (const t of recent) {
    if (!t.success) {
      sigCounts.set(t.signature, (sigCounts.get(t.signature) ?? 0) + 1);
    }
  }
  let maxSameFailure = 0;
  let maxSameFailureSig = '';
  for (const [sig, c] of sigCounts) {
    if (c > maxSameFailure) {
      maxSameFailure = c;
      maxSameFailureSig = sig;
    }
  }

  if (maxSameFailure >= 2) {
    return {
      confident: true,
      result: {
        progressMade: false,
        repeatedPattern: true,
        fallbackSuggested: true,
        reason: `同一工具调用「${truncate(maxSameFailureSig, 80)}」连续失败 ${maxSameFailure} 次，建议切换策略`,
        source: 'heuristic',
      },
    };
  }

  // 2. 触发源是 verification_failure：专用结论（先于「全部失败」，保证 reason 可归因到验证）
  if (ctx.trigger === 'verification_failure') {
    return {
      confident: true,
      result: {
        progressMade: false,
        repeatedPattern: false,
        fallbackSuggested: true,
        reason: '验证步骤失败，需要先定位根因再修复，避免反复 retry 验证命令',
        source: 'heuristic',
      },
    };
  }

  // 3. 最近全部失败
  if (recent.length >= 2 && !hadAnySuccess && hadAnyFailure) {
    return {
      confident: true,
      result: {
        progressMade: false,
        repeatedPattern: false,
        fallbackSuggested: true,
        reason: `最近 ${recent.length} 次工具调用全部失败，建议切换策略 / 检查环境`,
        source: 'heuristic',
      },
    };
  }

  // 4. 任务快照表明文件已变化或验证已通过 → progress
  const snap = ctx.taskSnapshot;
  if (snap) {
    if (snap.verificationStatus === 'passed') {
      return {
        confident: true,
        result: {
          progressMade: true,
          repeatedPattern: false,
          fallbackSuggested: false,
          reason: '验证已通过，当前步骤有进展',
          source: 'heuristic',
        },
      };
    }
    if (
      snap.filesChanged.length > 0
      && hadAnySuccess
      && snap.verificationStatus !== 'failed'
    ) {
      return {
        confident: true,
        result: {
          progressMade: true,
          repeatedPattern: false,
          fallbackSuggested: false,
          reason: `已修改 ${snap.filesChanged.length} 个文件且最近工具调用有成功，视为有进展`,
          source: 'heuristic',
        },
      };
    }
  }

  // 5. 模糊情况：有成功也有失败，让上层决定是否再调 LLM 复判
  if (hadAnySuccess) {
    if (snap?.verificationStatus === 'failed') {
      return {
        confident: false,
        result: {
          progressMade: false,
          repeatedPattern: false,
          fallbackSuggested: false,
          reason: '验证未通过，虽有部分工具成功，暂不视为有效进展',
          source: 'heuristic',
        },
      };
    }
    return {
      confident: false,
      result: {
        progressMade: true,
        repeatedPattern: false,
        fallbackSuggested: false,
        reason: '最近调用部分成功，但成败混合，难以仅靠启发式判定模式',
        source: 'heuristic',
      },
    };
  }

  // 6. 既无成功也无明显重复 → 弱结论，建议调 LLM
  return {
    confident: false,
    result: {
      progressMade: false,
      repeatedPattern: false,
      fallbackSuggested: false,
      reason: '工具轨迹不足以判定，建议进一步评估',
      source: 'heuristic',
    },
  };
}

/**
 * 轻量 LLM 评估。
 *
 * 严格约束：
 *   - 只发一条 user message（无系统 prompt，避免造成新的上下文）。
 *   - 关闭工具调用。
 *   - 期望模型返回单行 JSON，解析失败 → 返回 null 由调用方降级。
 */
async function llmReview(
  ctx: StepReviewContext,
  chatFn: ChatFunction,
): Promise<StepReviewResult | null> {
  const prompt = buildPrompt(ctx);
  const messages: UnifiedMessage[] = [{ role: 'user', content: prompt }];
  const response = await chatFn(messages, { tools: [] });
  const text = (response?.content ?? '').trim();
  const parsed = tryParseJson(text);
  if (!parsed) return null;

  // 字段宽容：缺失即 false / 空串
  return {
    progressMade: !!parsed.progressMade,
    repeatedPattern: !!parsed.repeatedPattern,
    fallbackSuggested: !!parsed.fallbackSuggested,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 280) : '',
    source: 'llm',
  };
}

function buildPrompt(ctx: StepReviewContext): string {
  const toolsList = ctx.recentTools.length === 0
    ? '(none)'
    : ctx.recentTools.map(
        (t, i) => `${i + 1}. ${t.toolName} ${t.success ? 'OK' : 'FAIL'}${t.error ? ` — ${truncate(t.error, 80)}` : ''}`,
      ).join('\n');

  const errorsList = ctx.lastErrors.length === 0
    ? '(none)'
    : ctx.lastErrors.map((e, i) => `${i + 1}. ${truncate(e, MAX_ERROR_LENGTH)}`).join('\n');

  return [
    'You are a strict internal runtime reviewer (NOT user-facing).',
    'Decide whether the agent is making progress, repeating the same action, or should fallback.',
    'Respond with a single-line JSON object, no prose, no markdown.',
    'Schema: {"progressMade":bool,"repeatedPattern":bool,"fallbackSuggested":bool,"reason":"<=120 chars"}',
    '',
    `Trigger: ${ctx.trigger}`,
    `Goal: ${truncate(ctx.goal, 200)}`,
    `CurrentStep: ${truncate(ctx.currentStep ?? '', 120)}`,
    '',
    'Recent tools:',
    toolsList,
    '',
    'Last errors:',
    errorsList,
  ].join('\n');
}

function tryParseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // 提取首个 {...} 段，容错 markdown code fence
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 把上下文裁剪到 bounded 大小，防止长任务 prompt 越来越大。 */
function trimContext(ctx: StepReviewContext): StepReviewContext {
  return {
    ...ctx,
    recentTools: ctx.recentTools.slice(-MAX_RECENT_TOOLS),
    lastErrors: ctx.lastErrors.slice(-MAX_LAST_ERRORS).map(e => truncate(e, MAX_ERROR_LENGTH)),
  };
}
