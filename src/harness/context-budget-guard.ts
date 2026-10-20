/**
 * 发送前总量检查：系统提示 + 工具定义 + 历史 + 易变块 + 输出预留不能超过上下文窗口。
 *
 * 超出时只收紧「本轮还没发给模型」的工具结果（上一次调用之后写入的那批），
 * 已发送过的历史不动，前缀缓存不受影响。收紧后仍超出的部分记为 overflow，
 * 交给 provider 报错后的紧急压缩兜底。
 */

import type { ToolDefinition, UnifiedMessage } from '../llm/types.js';
import { estimateMessagesTokens, estimateStringTokens, estimateToolsTokens } from '../llm/token-estimator.js';
import { toolResultViewText } from './compaction-strategy.js';
import { spillReadHint } from './tool-result-budget.js';

export interface PreSendBudgetResult {
  /** 按校准系数折算后的请求 token（不含输出预留） */
  totalTokens: number;
  limitTokens: number;
  shrunkResults: number;
  shrunkTokens: number;
  overflowTokens: number;
  /** 本地估算 × calibration ≈ provider 实际计数 */
  calibration: number;
  /** 未折算的本地估算（最终发送的视图），供下一轮校准 */
  estimatedTokens: number;
}

/** 校准系数只放大不缩小，避免估算偏低时以为放得下 */
const MAX_CALIBRATION = 3;

/**
 * 上一次请求的 provider 实际 prompt token / 当时的本地估算。
 * 没有数据或实际更少时取 1（保守，不放宽）。
 */
export function resolveBudgetCalibration(apiPromptTokens?: number, lastEstimatedTokens?: number): number {
  if (!apiPromptTokens || !lastEstimatedTokens || lastEstimatedTokens <= 0) return 1;
  return Math.min(MAX_CALIBRATION, Math.max(1, apiPromptTokens / lastEstimatedTokens));
}

/**
 * 本轮未发送的工具结果：最后一条 assistant 带 toolCalls 时，它之后的 tool 消息。
 * 最后一条 assistant 是纯文本回复时，之前的结果都已发过。
 */
function unsentToolResultIndexes(messages: UnifiedMessage[]): number[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0 || !messages[lastAssistant].toolCalls?.length) return [];
  const out: number[] = [];
  for (let i = lastAssistant + 1; i < messages.length; i++) {
    if (messages[i].role === 'tool') out.push(i);
  }
  return out;
}

function omittedForBudget(msg: UnifiedMessage): string {
  const meta = msg.toolResultMeta;
  const toolName = meta?.toolName ?? 'tool';
  const lead = `[${toolName} output omitted before sending: the request would exceed the context window. This is NOT the tool output.`;
  if (meta?.toolName === 'read_file' && meta.path) {
    const span = meta.lines ? ` lines ${meta.lines.start}-${meta.lines.end} of ${meta.lines.total} were not shown;` : '';
    return `${lead}${span} read_file path=${meta.path} with a small offset/limit to see it.]`;
  }
  if (meta?.spillPath) {
    return `${lead} Full output saved to: ${meta.spillPath} — read it with ${spillReadHint(meta.spillPath)}.]`;
  }
  return `${lead} The output was not saved; re-run the tool with narrower arguments.]`;
}

/**
 * 检查当轮请求是否放得下；放不下时把本轮未发送的结果从大到小换成恢复指引
 * （写进 apiSealedContent，content 保留原结果）。返回值里 shrunkResults > 0 时调用方需重建发送视图。
 */
export function enforcePreSendBudget(input: {
  canonical: UnifiedMessage[];
  view: UnifiedMessage[];
  tools?: ToolDefinition[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** {@link resolveBudgetCalibration}；缺省 1 */
  calibration?: number;
}): PreSendBudgetResult {
  const ratio = Math.max(1, input.calibration ?? 1);
  const limitTokens = Math.max(0, input.contextWindowTokens - input.maxOutputTokens);
  let estimated = estimateMessagesTokens(input.view) + estimateToolsTokens(input.tools);
  const scaled = () => Math.ceil(estimated * ratio);
  const result: PreSendBudgetResult = {
    totalTokens: scaled(),
    limitTokens,
    shrunkResults: 0,
    shrunkTokens: 0,
    overflowTokens: 0,
    calibration: ratio,
    estimatedTokens: estimated,
  };
  if (result.totalTokens <= limitTokens) return result;

  const candidates = unsentToolResultIndexes(input.canonical)
    .filter(i => input.canonical[i].apiSealedBy !== 'pressureClear')
    .map(i => ({ i, tokens: estimateStringTokens(toolResultViewText(input.canonical[i])) }))
    .sort((a, b) => b.tokens - a.tokens);

  for (const { i, tokens } of candidates) {
    if (scaled() <= limitTokens) break;
    const msg = input.canonical[i];
    const stub = omittedForBudget(msg);
    const stubTokens = estimateStringTokens(stub);
    if (stubTokens >= tokens) continue;
    const meta = msg.toolResultMeta;
    let nextMeta = meta;
    if (meta) {
      // 读文件的行没有真正发出去：改记为省略，免得被当成已读、去取代更早的读取
      const { lines, ...rest } = meta;
      nextMeta = {
        ...rest,
        strategy: 'omitted',
        injectedChars: stub.length,
        injectedTokens: stubTokens,
        ...(lines ? { omittedLines: [[lines.start, lines.end] as [number, number]] } : {}),
      };
    }
    input.canonical[i] = {
      ...msg,
      apiSealedContent: stub,
      apiSealedBy: 'resultBudget',
      ...(nextMeta ? { toolResultMeta: nextMeta } : {}),
    };
    estimated -= tokens - stubTokens;
    result.shrunkResults++;
    result.shrunkTokens += tokens - stubTokens;
  }

  result.estimatedTokens = estimated;
  result.totalTokens = scaled();
  result.overflowTokens = Math.max(0, result.totalTokens - limitTokens);
  return result;
}
