/**
 * 单次输出被 max_tokens 截断、且本轮没有 API 工具调用时，决定怎么续。
 * 有可看的正文就先接上；正文是空的、只有思考、或只剩没解析成功的工具文本时，
 * 丢掉半截，要求改发一小批工具。连续没有进展就停，不再重复「从断点继续」。
 */

import type { LLMResponse } from '../llm/types.js';
import { MAX_OUTPUT_TOKENS_RECOVERY_LIMIT } from './harness-constants.js';
import { isReasoningOnlyResponse } from './incomplete-completion.js';
import {
  sanitizeAssistantContentForUser,
  STRIPPED_EMBEDDED_TOOL_NOTICE,
} from './text-tool-call-salvage.js';

/** 没有可执行结果时，小批量提示最多注入这么多次，下一次再顶满就停。 */
export const OUTPUT_LIMIT_NO_PROGRESS_RECOVERY_LIMIT = 2;

export const OUTPUT_LIMIT_RESUME_PROMPT = [
  'Continue directly — do not apologize, do not restate previous content.',
  'If the last response was cut off mid-way, continue from where it left off.',
  'Split remaining work into smaller steps.',
].join(' ');

export const OUTPUT_LIMIT_SMALL_BATCH_PROMPT = [
  '[System] The previous response used the entire output budget and produced no executable tool call.',
  'The truncated payload was discarded. Do not resume it and do not restate the plan.',
  'Call tools now with ONE small batch only: one primitive, one small patch, or a few commands.',
  'Never emit the whole task in a single response.',
].join('\n');

/** 截断的工具 JSON / 标记从这里开始。后面的半截不进历史。 */
const TRAILING_TOOL_PAYLOAD =
  /\{\s*"(?:name|tool|function_name|tool_calls|function)"|<tool[_-]?call>|<invoke\b|<\][a-zA-Z]|\[调用工具:/i;

export type OutputLimitRecoveryKind = 'prose' | 'no_progress';

export type OutputLimitRecoveryDecision =
  | { type: 'resume'; prompt: string; keepAssistant: true }
  | { type: 'small_batch'; prompt: string; keepAssistant: boolean }
  | { type: 'stop'; content: string };

/**
 * 截断回复里还值得留下的正文。
 * 空回复、只有思考、剥光后的工具占位，以及没闭合的工具 JSON，都返回空串。
 */
export function resumableOutputLimitText(content: string | undefined): string {
  let visible = sanitizeAssistantContentForUser(content).trim();
  if (!visible || visible === STRIPPED_EMBEDDED_TOOL_NOTICE) return '';
  const cut = visible.search(TRAILING_TOOL_PAYLOAD);
  if (cut >= 0) visible = visible.slice(0, cut).trim();
  if (!visible || visible === STRIPPED_EMBEDDED_TOOL_NOTICE) return '';
  return visible;
}

export function classifyOutputLimitRecovery(response: LLMResponse): OutputLimitRecoveryKind {
  if (isReasoningOnlyResponse(response)) return 'no_progress';
  if (!resumableOutputLimitText(response.content)) return 'no_progress';
  return 'prose';
}

/**
 * recoveryCount 是已经注入过的恢复次数。
 * 有正文：第 1 次续写，其后直到总上限改要一小批工具，并保留正文。
 * 无进展：只注入小批量提示，保留次数更少，不把半截写进历史。
 */
export function decideOutputLimitRecovery(
  response: LLMResponse,
  recoveryCount: number,
): OutputLimitRecoveryDecision {
  const kind = classifyOutputLimitRecovery(response);
  if (kind === 'prose' && recoveryCount < 1) {
    return { type: 'resume', prompt: OUTPUT_LIMIT_RESUME_PROMPT, keepAssistant: true };
  }
  const ceiling = kind === 'prose'
    ? MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
    : OUTPUT_LIMIT_NO_PROGRESS_RECOVERY_LIMIT;
  if (recoveryCount < ceiling) {
    return {
      type: 'small_batch',
      prompt: OUTPUT_LIMIT_SMALL_BATCH_PROMPT,
      keepAssistant: kind === 'prose',
    };
  }
  return {
    type: 'stop',
    content: kind === 'prose' ? resumableOutputLimitText(response.content) : '',
  };
}
