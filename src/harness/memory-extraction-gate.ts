/**
 * LLM 记忆提取门控（Harness onLoopEnd）。
 *
 * 目标态：默认不写 → 信号词 / 用户 feedback → 长对话 + 工具轮 + 节流。
 * 禁止名词启发式（mysql/docker/vite 等）；ops 类任务默认跳过。
 */

import type { TaskIntent } from '../types/runtime-snapshot.js';
import type { CasualExtractionConfig, ExtractionRemoteConfig } from '../memory/file-memory/memory-config.js';
import { EXTRACTION_SIGNAL_WORDS } from '../memory/file-memory/memory-config.js';
import { evaluateCasualMemoryExtraction, shouldApplyCasualHarness } from './casual-mode.js';

/** 用户纠正 / 反馈类表述（可升格为 feedback 记忆；不与信号词完全重叠） */
const USER_FEEDBACK_PATTERNS: RegExp[] = [
  /(?:这样|这么做)(?:不好|不对)/,
  /(?:wrong|incorrect)\s+(?:approach|way)/i,
  /(?:别|不要|不用|禁止|never|don't).{0,20}(?:用|写|加|做).{0,20}(?:了|吧|啊)/,
];

/** 强 ops：安装/部署/解压等明确语境 */
const STRONG_OPS_MESSAGE_PATTERNS: RegExp[] = [
  /zip.*装|安装\s*(?:mysql|docker|nginx|redis|node|python)/i,
  /部署|解压.*(?:install|mysql|docker)|装\s*(?:mysql|docker|nginx|redis)/i,
  /\b(install|deploy|setup|configure|download|unzip)\s+(?:mysql|docker|nginx|redis|zip)/i,
];

/** 弱 ops 信号（需结合 intent / 命令判断） */
const WEAK_OPS_MESSAGE_PATTERNS: RegExp[] = [
  /安装|部署|下载|解压|配置环境/i,
  /(?:apt|yum|brew|choco|winget)\s+(?:install|upgrade)/i,
  /docker\s+(?:run|compose|pull)/i,
];

const OPS_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:apt|yum|brew|choco|winget)\s+install\b/i,
  /\bdocker\s+(?:run|compose|pull)\b/i,
  /\b(?:curl|wget)\s+/i,
  /\bmysql\s+(?:install|setup|init)\b/i,
];

const DEV_PACKAGE_INSTALL_ONLY_RE = /^(?:npm|pnpm|yarn)\s+(?:install|ci)(?:\s|$)/i;

export function hasExtractionSignalWord(message: string): boolean {
  const lower = message.toLowerCase();
  return EXTRACTION_SIGNAL_WORDS.some(w => lower.includes(w.toLowerCase()));
}

export function isUserFeedbackSignal(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (hasExtractionSignalWord(trimmed)) return false;
  return USER_FEEDBACK_PATTERNS.some(p => p.test(trimmed));
}

export function isOpsTaskContext(
  userMessage: string,
  commandsRun: string[] = [],
  taskIntent?: TaskIntent,
): boolean {
  const msg = userMessage.trim();

  if (msg && STRONG_OPS_MESSAGE_PATTERNS.some(p => p.test(msg))) {
    return true;
  }

  const weakMsg = msg && WEAK_OPS_MESSAGE_PATTERNS.some(p => p.test(msg));
  const cmdOps = commandsRun.some(cmd => OPS_COMMAND_PATTERNS.some(p => p.test(cmd)));

  if (!weakMsg && !cmdOps) return false;

  if (cmdOps && commandsRun.length > 0) {
    const allDevInstall = commandsRun.every(c => DEV_PACKAGE_INSTALL_ONLY_RE.test(c.trim()));
    const noOpsGoal = !/(?:安装|部署|解压|deploy|setup|configure|download|unzip)/i.test(msg);
    if (
      allDevInstall
      && noOpsGoal
      && (taskIntent === 'test' || taskIntent === 'debug' || taskIntent === 'refactor')
    ) {
      return false;
    }
  }

  if (weakMsg && taskIntent === 'edit' && !/(?:安装|部署|解压|装\s|deploy|setup)/i.test(msg)) {
    if (/\b(mysql|docker|nginx|redis)\b/i.test(msg) && !/(?:安装|部署|装)/i.test(msg)) {
      return false;
    }
  }

  return weakMsg || cmdOps;
}

function passesDepthGates(input: MemoryExtractionGateInput): string | null {
  const counter = input.extractionTurnCounter + 1;
  if (counter < input.extractionConfig.turnThrottle) {
    return 'turn_throttle';
  }
  if (input.turnCount < input.extractionConfig.minTurns) {
    return 'min_turns';
  }
  const minTokens = input.extractionConfig.minTokens;
  if (minTokens > 0 && (input.totalInputTokens ?? 0) < minTokens) {
    return 'min_tokens';
  }
  if (!input.sessionHasToolCalls) {
    return 'no_tool_calls';
  }
  const interval = input.extractionConfig.toolCallInterval;
  if (interval > 1 && input.toolCallsSinceLastExtract < interval) {
    return 'tool_call_interval';
  }
  return null;
}

export interface MemoryExtractionGateInput {
  turnCount: number;
  currentUserMessage: string;
  totalInputTokens?: number;
  sessionHasToolCalls: boolean;
  toolCallsSinceLastExtract: number;
  extractionTurnCounter: number;
  sessionSuccessfulExtractCount: number;
  sessionExtractWrittenCount: number;
  taskIntent?: TaskIntent;
  commandsRun?: string[];
  extractionConfig: ExtractionRemoteConfig;
  casualConfig: CasualExtractionConfig;
}

export interface MemoryExtractionGateResult {
  allow: boolean;
  resetTurnCounter?: boolean;
  reason?: string;
}

/**
 * 判断是否应触发 LLM 记忆提取。
 */
export function evaluateMemoryExtractionGate(input: MemoryExtractionGateInput): MemoryExtractionGateResult {
  const msg = input.currentUserMessage.trim();
  if (!msg) {
    return { allow: false, reason: 'empty_message' };
  }

  if (input.sessionSuccessfulExtractCount >= 1) {
    return { allow: false, reason: 'session_extract_cap' };
  }

  const hasSignal = hasExtractionSignalWord(msg);
  const hasFeedback = isUserFeedbackSignal(msg);

  const opsTask = isOpsTaskContext(msg, input.commandsRun ?? [], input.taskIntent);
  if (opsTask && !hasSignal && !hasFeedback) {
    return { allow: false, reason: 'ops_task' };
  }

  if (hasSignal) {
    return { allow: true, reason: 'signal_word' };
  }

  if (hasFeedback) {
    return { allow: true, reason: 'user_feedback' };
  }

  const intent = input.taskIntent;
  if (intent && shouldApplyCasualHarness(intent)) {
    const depthBlock = passesDepthGates(input);
    if (depthBlock) {
      return { allow: false, reason: depthBlock === 'turn_throttle' ? 'casual_depth_blocked' : depthBlock };
    }
    const counter = input.extractionTurnCounter + 1;
    const allow = evaluateCasualMemoryExtraction({
      turnCount: input.turnCount,
      hasSignalWord: false,
      hasContentSignal: false,
      sessionHasToolCalls: input.sessionHasToolCalls,
      extractionTurnCounter: counter,
      turnThrottle: input.extractionConfig.turnThrottle,
      config: input.casualConfig,
    });
    return allow
      ? { allow: true, resetTurnCounter: true, reason: 'casual_depth' }
      : { allow: false, reason: 'casual_depth_blocked' };
  }

  const depthBlock = passesDepthGates(input);
  if (depthBlock) {
    return { allow: false, reason: depthBlock };
  }

  return { allow: true, resetTurnCounter: true, reason: 'depth_gate' };
}
