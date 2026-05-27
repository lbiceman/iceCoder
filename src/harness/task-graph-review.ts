/**
 * Node Contract Layer — 执行稳定性核心。
 *
 * 包含：
 *   1. ContractValidator — 节点合约检查器
 *   2. DeviationDetector — 偏离检测器
 *   3. FailureClassifier — 失败分类器（11 种）
 *   4. EscalationPolicy — 四级升级策略
 *   5. NodeCostTracker — 节点成本预算追踪
 *
 * v1：纯规则驱动，不调用 LLM。
 * 依赖：Phase 1 (types)
 *
 * 设计文档：docs/任务图规划-设计文档.md §20, §26, §27, §33
 */

import type {
  NodeContract,
  OutputSignal,
  ContractCheckResult,
  ContractViolation,
  DeviationResult,
  CorrectionAction,
  ClassifiedFailure,
  FailureCategory,
  FailureSeverity,
  RecoveryAction,
  EscalationPolicy,
  EscalationLevel,
  EscalationEntry,
  NodeCostBudget,
  NodeCostTracker,
  FallbackReason,
} from '../types/task-graph.js';
import type { TaskPhase } from '../types/runtime-snapshot.js';

// ═══════════════════════════════════════════════
// ContractValidator
// ═══════════════════════════════════════════════

export class ContractValidator {
  private contract: NodeContract;
  private currentRound = 0;
  private toolCallCount = 0;
  private readonly sameToolStreak = new Map<string, number>();
  private readonly outputSignals = new Set<OutputSignal>();
  private idleRounds = 0;

  constructor(contract: NodeContract) {
    this.contract = contract;
  }

  /** 工具调用前检查 */
  checkBeforeToolCall(toolName: string, opts: { track?: boolean } = {}): ContractCheckResult {
    const track = opts.track ?? true;
    const violations: ContractViolation[] = [];

    // 硬边界：forbiddenTools 直接拒绝
    if (this.contract.forbiddenTools.includes(toolName)) {
      return {
        passed: false,
        violations: [{ type: 'forbidden_tool', detail: `工具 ${toolName} 在当前节点被禁止`, severity: 'error' }],
        action: 'block',
        message: `[Contract] 当前节点不允许使用 ${toolName}。允许: ${this.contract.allowedTools.join(', ')}`,
      };
    }

    // 白名单检查
    if (this.contract.allowedTools.length > 0 && !this.contract.allowedTools.includes(toolName)) {
      if (this.contract.nodeGuard.enforceToolBoundary) {
        return {
          passed: false,
          violations: [{ type: 'forbidden_tool', detail: `${toolName} 不在允许列表中`, severity: 'warning' }],
          action: this.contract.nodeGuard.deviationTolerance === 'strict' ? 'block' : 'warn',
          message: `[Contract] ${toolName} 不在当前节点建议工具中。建议: ${this.contract.allowedTools.join(', ')}`,
        };
      }
    }

    // 重复工具检查
    const streak = (this.sameToolStreak.get(toolName) ?? 0) + 1;
    if (track) {
      this.sameToolStreak.set(toolName, streak);
    }
    if (streak > this.contract.nodeGuard.maxSameToolRepeat) {
      violations.push({
        type: 'repeat_tool',
        detail: `工具 ${toolName} 已连续调用 ${streak} 次（上限 ${this.contract.nodeGuard.maxSameToolRepeat}）`,
        severity: 'warning',
      });
    }

    return {
      passed: violations.length === 0,
      violations,
      action: violations.length > 0 ? 'warn' : 'allow',
      message: violations.length > 0 ? `[Contract] 警告：${violations.map(v => v.detail).join('; ')}` : undefined,
    };
  }

  /** 工具调用后记录 */
  recordAfterToolCall(toolName: string, success: boolean, signal?: OutputSignal): void {
    this.toolCallCount++;
    if (signal) this.outputSignals.add(signal);
    if (!success) this.sameToolStreak.delete(toolName);
  }

  /** 轮次结束后检查 */
  checkRoundEnd(toolCallsThisRound: number): ContractCheckResult {
    this.currentRound++;
    const violations: ContractViolation[] = [];

    if (toolCallsThisRound === 0) {
      this.idleRounds++;
      if (this.idleRounds > this.contract.nodeGuard.maxIdleRounds) {
        violations.push({
          type: 'idle_round',
          detail: `连续 ${this.idleRounds} 轮无工具调用（上限 ${this.contract.nodeGuard.maxIdleRounds}）`,
          severity: 'error',
        });
      }
    } else {
      this.idleRounds = 0;
    }

    if (this.currentRound > this.contract.completionCriteria.maxRounds) {
      violations.push({
        type: 'round_exceeded',
        detail: `已达最大轮次 ${this.contract.completionCriteria.maxRounds}`,
        severity: 'error',
      });
    }

    return {
      passed: violations.length === 0,
      violations,
      action: violations.length > 0 ? 'force_switch' : 'allow',
      message: violations.length > 0 ? `[Contract] 守卫触发：${violations.map(v => v.detail).join('; ')}` : undefined,
    };
  }

  /** 判断节点是否完成 */
  checkCompletion(): { completed: boolean; reason?: string } {
    const { requiredSignals, minToolCalls } = this.contract.completionCriteria;

    if (this.toolCallCount < minToolCalls) {
      return { completed: false, reason: `工具调用次数不足（${this.toolCallCount}/${minToolCalls}）` };
    }

    const missing = requiredSignals.filter(s => !this.outputSignals.has(s));
    if (missing.length > 0) {
      return { completed: false, reason: `缺少输出信号: ${missing.join(', ')}` };
    }

    return { completed: true };
  }

  reset(newContract?: NodeContract): void {
    if (newContract) this.contract = newContract;
    this.currentRound = 0;
    this.toolCallCount = 0;
    this.sameToolStreak.clear();
    this.outputSignals.clear();
    this.idleRounds = 0;
  }
}

// ═══════════════════════════════════════════════
// DeviationDetector
// ═══════════════════════════════════════════════

export interface DeviationInput {
  /** 当前工具调用名列表 */
  toolNames: string[];
  /** 节点的允许工具列表 */
  allowedTools: string[];
  /** 当前节点 phase */
  nodePhase: TaskPhase;
  /** 节点守卫配置 */
  nodeGuard: { maxSameToolRepeat: number };
}

function inferPhaseFromTools(toolNames: string[]): TaskPhase {
  if (toolNames.some(n => n === 'write_file' || n === 'edit_file' || n === 'patch_file' || n === 'batch_edit_file')) return 'editing';
  if (toolNames.some(n => n === 'run_command')) return 'verification';
  return 'context';
}

export class DeviationDetector {
  detect(input: DeviationInput): DeviationResult {
    const { toolNames, allowedTools, nodePhase, nodeGuard } = input;
    const calledSet = new Set(toolNames);
    const allowedSet = new Set(allowedTools);

    // 工具匹配检查
    const overlap = [...calledSet].filter(t => allowedSet.has(t));
    if (overlap.length === 0 && allowedTools.length > 0) {
      return {
        deviated: true,
        type: 'tool_mismatch',
        severity: 'hard',
        correction: {
          type: 'inject_hint',
          message: `[Contract] 当前节点需要以下工具之一: ${allowedTools.join(', ')}。请聚焦当前步骤。`,
        },
        description: `调用了 ${[...calledSet].join(', ')}，但节点要求 ${allowedTools.join(', ')}`,
      };
    }

    // 范围蔓延检查（先于 phase 检查：edit 节点大量只读属 scope_creep）
    const isReadTool = (n: string) => n.startsWith('read') || n === 'search_codebase' || n === 'fs_operation';
    if (nodePhase === 'editing' && allowedTools.includes('write_file') && toolNames.every(isReadTool)) {
      if (toolNames.length > nodeGuard.maxSameToolRepeat) {
        return {
          deviated: true,
          type: 'scope_creep',
          severity: 'soft',
          correction: {
            type: 'inject_hint',
            message: '[Contract] 已读取足够上下文。当前节点需要开始编辑操作。',
          },
          description: `edit 节点只读轮次过多 (${toolNames.length})`,
        };
      }
    }

    // Phase 匹配检查
    const calledPhase = inferPhaseFromTools(toolNames);
    if (calledPhase !== nodePhase && calledPhase !== 'intent') {
      return {
        deviated: true,
        type: 'phase_mismatch',
        severity: 'soft',
        correction: {
          type: 'inject_hint',
          message: `[Contract] 当前阶段为「${nodePhase}」，但你的操作看起来属于「${calledPhase}」。请先完成当前步骤。`,
        },
        description: `Phase 不匹配: node=${nodePhase}, actual=${calledPhase}`,
      };
    }

    return { deviated: false, type: 'none', severity: 'soft', correction: { type: 'inject_hint', message: '' }, description: '' };
  }
}

// ═══════════════════════════════════════════════
// FailureClassifier
// ═══════════════════════════════════════════════

export interface FailureContext {
  toolName?: string;
  filesRead: string[];
}

export class FailureClassifier {
  private nextId = 1;

  classify(error: string, toolName?: string, ctx?: FailureContext): ClassifiedFailure {
    const normalized = error.toLowerCase().trim();
    const id = `fail-${this.nextId++}`;
    const at = Date.now();
    const raw = error.slice(0, 300);

    // 1. hallucinated_path（优先于通用 file_not_found：read_file+enoent 是幻觉）
    if (toolName === 'read_file' && /enoent|not.found/i.test(normalized)) {
      return { failureId: id, category: 'hallucinated_path', subType: 'file_not_found', severity: 'recoverable',
        nodeId: '', toolName, rawError: raw, at,
        suggestedRecovery: { strategy: 'retry_with_hint', hint: '文件不存在。用 write_file 创建完整文件，或 read_file 同目录已有文件作模板；勿反复 read 缺失路径。' } };
    }

    // 2. tool_error: file not found（非 read_file 的 enoent）
    if (toolName && normalized.includes('enoent')) {
      return { failureId: id, category: 'tool_error', subType: 'file_not_found', severity: 'recoverable',
        nodeId: '', toolName, toolSignature: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'retry_with_hint', hint: '文件不存在。请使用 search_codebase 查找正确的文件路径。' } };
    }

    // 2. permission_denied
    if (toolName && /eacces|eperm|access denied/i.test(normalized)) {
      return { failureId: id, category: 'permission_denied', subType: 'file_permission', severity: 'recoverable',
        nodeId: '', toolName, toolSignature: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'alternative_tool', suggestedTools: ['read_file', 'search_codebase'] } };
    }

    // 3. syntax error
    if (toolName && /syntax.error|unexpected.token|parse.error/i.test(normalized)) {
      return { failureId: id, category: 'tool_error', subType: 'syntax_error', severity: 'recoverable',
        nodeId: '', toolName, toolSignature: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'retry', maxAttempts: 2 } };
    }

    // 4. verification_fail: test
    if (/test.*fail|assertion.*fail|expect.*not/i.test(normalized)) {
      return { failureId: id, category: 'verification_fail', subType: 'test_failed', severity: 'recoverable',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'narrow_scope', message: '测试失败。请检查失败的测试用例输出。' } };
    }

    // 5. verification_fail: type error
    if (/tsc.*error|type.*error|cannot.find.module/i.test(normalized)) {
      return { failureId: id, category: 'verification_fail', subType: 'type_error', severity: 'recoverable',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'retry_with_hint', hint: '类型错误。请根据 tsc 输出修复类型不匹配。' } };
    }

    // 6. context_missing
    if (ctx && ctx.filesRead.length === 0 && /cannot.*find|cannot.*locate|unable.*read/i.test(normalized)) {
      return { failureId: id, category: 'context_missing', subType: 'insufficient_exploration', severity: 'recoverable',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'expand_context', method: 'sub_agent' } };
    }

    // 7. contract_violation
    if (/contract.*violat|forbidden.*tool|not.in.allowed/i.test(normalized)) {
      return { failureId: id, category: 'contract_violation', subType: 'forbidden_tool_call', severity: 'recoverable',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'retry_with_hint', hint: '请使用当前节点允许的工具。' } };
    }

    // 8. repo_mismatch
    if (/package.json.*not.found|tsconfig.*not.found|no.such.project/i.test(normalized)) {
      return { failureId: id, category: 'repo_mismatch', subType: 'expected_config_missing', severity: 'degraded',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'skip_node', reason: '项目配置文件不存在，跳过依赖该配置的步骤。' } };
    }

    // 9. branch_exhausted
    if (/all.*fallback.*exhausted|no.*more.*branch|circuit.*breaker/i.test(normalized)) {
      return { failureId: id, category: 'branch_exhausted', subType: 'no_fallback_remaining', severity: 'fatal',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'ask_user', question: '所有策略均已尝试但未成功。是否需要调整方案？' } };
    }

    // 11. timeout
    if (/timeout|timed.out|deadline.exceeded/i.test(normalized)) {
      return { failureId: id, category: 'timeout', subType: 'operation_timeout', severity: 'recoverable',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'narrow_scope', message: '操作超时。请缩小范围或分步执行。' } };
    }

    // 12. token_exhausted
    if (/token.*limit|context.*length|max.*token/i.test(normalized)) {
      return { failureId: id, category: 'token_exhausted', subType: 'context_limit', severity: 'degraded',
        nodeId: '', rawError: raw, at,
        suggestedRecovery: { strategy: 'narrow_scope', message: '上下文过长。请精简操作范围。' } };
    }

    // fallback
    return { failureId: id, category: 'tool_error', subType: 'unknown', severity: 'recoverable',
      nodeId: '', rawError: raw, at,
      suggestedRecovery: { strategy: 'retry', maxAttempts: 1 } };
  }

  reset(): void { this.nextId = 1; }
}

// ═══════════════════════════════════════════════
// EscalationPolicy (四级升级)
// ═══════════════════════════════════════════════

export const DEFAULT_ESCALATION: EscalationPolicy = {
  thresholds: [
    { level: 0 as EscalationLevel, consecutiveDeviations: 1, maxCorrectionAttempts: 99, action: { type: 'none' } },
    { level: 1 as EscalationLevel, consecutiveDeviations: 2, maxCorrectionAttempts: 2, action: { type: 'inject_hint', message: '' } },
    { level: 2 as EscalationLevel, consecutiveDeviations: 1, maxCorrectionAttempts: 1, action: { type: 'block_and_reset', blockedTools: [], message: '' } },
    { level: 3 as EscalationLevel, consecutiveDeviations: 1, maxCorrectionAttempts: 1, action: { type: 'force_branch_switch', reason: 'repeated_failure' } },
  ],
  currentLevel: 0 as EscalationLevel,
  history: [],
};

export class EscalationManager {
  policy: EscalationPolicy;
  private deviationCounter = 0;
  private correctionAttempts = 0;

  constructor(policy?: EscalationPolicy) {
    this.policy = policy ?? structuredClone(DEFAULT_ESCALATION);
  }

  /** 根据偏离严重程度评估升级 */
  evaluate(severity: 'soft' | 'hard' | 'critical', nodeId: string):
    { action: 'none' | 'inject_hint' | 'block' | 'force_switch'; message?: string; blockedTools?: string[] } {
    const prev = this.policy.currentLevel;

    this.deviationCounter++;

    if (severity === 'critical') {
      this.advanceTo(3, nodeId, 'critical severity');
      return { action: 'force_switch', message: '严重偏离，强制切换分支。' };
    }

    if (severity === 'hard') {
      if (this.policy.currentLevel < 1) this.advanceTo(1, nodeId, 'hard severity');
      else this.advanceTo(2, nodeId, 'persistent hard severity');
    }

    // soft: 连续偏离达到阈值才升级
    if (severity === 'soft' && this.deviationCounter >= 2 && this.policy.currentLevel === 0) {
      this.advanceTo(1, nodeId, 'consecutive soft deviations');
    }

    // 执行当前级别的动作
    switch (this.policy.currentLevel) {
      case 1: {
        const used = this.correctionAttempts++ >= 2 && this.policy.currentLevel < 2;
        if (used) this.advanceTo(2, nodeId, 'correction attempts exhausted');
        return { action: 'inject_hint', message: `[Escalation L1] 检测到偏离，请聚焦当前节点。` };
      }
      case 2: {
        const used = this.correctionAttempts++ >= 1 && this.policy.currentLevel < 3;
        if (used) this.advanceTo(3, nodeId, 'block correction exhausted');
        return { action: 'block', message: '[Escalation L2] 硬纠正：请使用允许的工具。', blockedTools: [] };
      }
      case 3:
        return { action: 'force_switch', message: '[Escalation L3] 强制切换分支。' };
      default:
        return { action: 'none' };
    }
  }

  /** 成功恢复后降级 */
  deescalate(): void {
    if (this.policy.currentLevel > 0) {
      this.policy.currentLevel = Math.max(0, this.policy.currentLevel - 1) as EscalationLevel;
      this.deviationCounter = 0;
      this.correctionAttempts = 0;
    }
  }

  reset(): void {
    this.policy.currentLevel = 0;
    this.policy.history = [];
    this.deviationCounter = 0;
    this.correctionAttempts = 0;
  }

  private advanceTo(level: EscalationLevel, nodeId: string, reason: string): void {
    const from = this.policy.currentLevel;
    this.policy.currentLevel = level;
    this.policy.history.push({ fromLevel: from, toLevel: level, reason, at: Date.now(), nodeId });
    this.correctionAttempts = 0;
  }
}

// ═══════════════════════════════════════════════
// NodeCostTracker
// ═══════════════════════════════════════════════

export class NodeCostTrackerImpl implements NodeCostTracker {
  tokensUsed = 0;
  roundsUsed = 0;
  toolCallsUsed = 0;
  startedAt = 0;
  exhaustedBy: 'tokens' | 'rounds' | 'tool_calls' | 'duration' | undefined;
  utilizationRate = 0;

  private budget: NodeCostBudget;

  constructor(budget: NodeCostBudget) {
    this.budget = budget;
    this.startedAt = Date.now();
  }

  addTokens(tokens: number): boolean {
    this.tokensUsed += tokens;
    return this.checkBudget();
  }

  addRound(toolCount: number): boolean {
    this.roundsUsed++;
    this.toolCallsUsed += toolCount;
    return this.checkBudget();
  }

  isExhausted(): boolean {
    return !!this.exhaustedBy;
  }

  getBudget(): NodeCostBudget {
    return this.budget;
  }

  private checkBudget(): boolean {
    if (this.tokensUsed > this.budget.maxTokens) { this.exhaustedBy = 'tokens'; }
    else if (this.roundsUsed > this.budget.maxRounds) { this.exhaustedBy = 'rounds'; }
    else if (this.toolCallsUsed > this.budget.maxToolCalls) { this.exhaustedBy = 'tool_calls'; }
    else if (Date.now() - this.startedAt > this.budget.maxDurationMs) { this.exhaustedBy = 'duration'; }

    // utilization: max across all dimensions
    this.utilizationRate = Math.max(
      this.tokensUsed / this.budget.maxTokens,
      this.roundsUsed / this.budget.maxRounds,
      this.toolCallsUsed / this.budget.maxToolCalls,
      (Date.now() - this.startedAt) / this.budget.maxDurationMs,
    );
    return !!this.exhaustedBy;
  }
}
