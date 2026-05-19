/**
 * 日常对话减负（默认开启，无环境变量）。
 *
 * 对 question / inspect 降低 Harness 注入与 checkpoint 频率；
 * 工程 intent（edit/debug/test/refactor）行为不变。
 * LLM 记忆提取的中间档见 `evaluateCasualMemoryExtraction` + memory-config.json `casualExtraction`。
 */

import type { CasualExtractionConfig } from '../memory/file-memory/memory-config.js';
import type { TaskIntent } from '../types/runtime-snapshot.js';

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
