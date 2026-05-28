/**
 * 日常对话减负（默认开启，无环境变量）。
 *
 * 对 question / inspect 降低 Harness 注入与 checkpoint 频率；
 * 工程 intent（edit/debug/test/refactor）行为不变。
 * LLM 记忆提取的中间档见 `evaluateCasualMemoryExtraction` + memory-config.json `casualExtraction`。
 */

import type { CasualExtractionConfig } from '../memory/file-memory/memory-config.js';
import type { ToolDefinition } from '../llm/types.js';
import type { TaskIntent } from '../types/runtime-snapshot.js';
import { isActionableToolRequest } from './harness-message-utils.js';
import { hasExecutableSideSignal, inferIntent } from './task-state.js';

const CASUAL_INTENTS: ReadonlySet<TaskIntent> = new Set(['question', 'inspect']);

export function isCasualIntent(intent: TaskIntent): boolean {
  return CASUAL_INTENTS.has(intent);
}

/** question / inspect 时应用日常 Harness 减负 */
export function shouldApplyCasualHarness(intent: TaskIntent): boolean {
  return isCasualIntent(intent);
}

/** 日常 intent 下跳过 Resilience v2 checkpoint 写入 */
export function shouldSkipResilienceCheckpoint(intent: TaskIntent): boolean {
  return shouldApplyCasualHarness(intent);
}

/**
 * 纯 question 寒暄判定（仅供测试 / 日后可选优化参考）。
 * 当前 LLM 请求始终携带 tools，本函数不参与运行时 omit-tools 决策。
 */
export function shouldUseCasualLlmFastPath(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  const intent = inferIntent(text);
  if (intent !== 'question') return false;
  if (isActionableToolRequest(text)) return false;
  if (hasExecutableSideSignal(text)) return false;
  return true;
}

export interface ResolveLlmToolsOptions {
  /** 本会话中真实 user 消息是否仅一条（首条寒暄 fast path 才安全） */
  isFirstUserTurnInSession?: boolean;
}

/** 无 tools 时追加到 LLM 请求（不写回会话 history）的提醒。 */
export function buildNoToolsLlmReminder(): string {
  return `<system-reminder>
当前 LLM 请求未携带工具 API（function calling）。请仅用自然语言回复。
禁止在正文输出 &lt;tool_call&gt;、&lt;function=...&gt; 等 XML/文本形态的工具调用；不要假装读取或修改文件。
</system-reminder>`;
}

/** 按轮次解析 LLM 侧 tools：始终返回全量 tools（与 API function calling 一致）。 */
export function resolveLlmToolsForRound(
  tools: ToolDefinition[],
  _round?: number,
  _userMessage?: string,
  _options?: ResolveLlmToolsOptions,
): ToolDefinition[] {
  return tools;
}

export interface CasualMemoryExtractionInput {
  turnCount: number;
  hasSignalWord: boolean;
  hasContentSignal: boolean;
  sessionHasToolCalls: boolean;
  extractionTurnCounter: number;
  turnThrottle: number;
  config: CasualExtractionConfig;
}

/**
 * question / inspect：信号词 / 内容特征应在调用方先判断；
 * 本函数仅处理「轮次深度」路径（调用前须已 `extractionTurnCounter++`）。
 */
export function evaluateCasualMemoryExtraction(input: CasualMemoryExtractionInput): boolean {
  if (input.hasSignalWord) return true;

  if (
    input.hasContentSignal
    && input.turnCount >= 1
    && input.config.allowContentSignalWithoutTools
  ) {
    return true;
  }

  if (input.extractionTurnCounter < input.turnThrottle) {
    return false;
  }

  if (input.turnCount < input.config.minTurns) {
    return false;
  }

  if (input.config.requireToolCalls && !input.sessionHasToolCalls) {
    return false;
  }

  return true;
}
