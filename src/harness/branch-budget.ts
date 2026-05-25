/**
 * BranchBudgetTracker — 分支执行预算追踪器。
 *
 * 目的：防止 Harness 在同一条策略上无限重复（同一文件反复编辑、
 * 同一命令反复重试、同一错误反复出现），从而拖死长任务。
 *
 * 设计要点：
 *   - 纯本地、纯内存、零 LLM 成本；与现有 Harness 解耦。
 *   - 超限时由 Harness 工具执行层 **硬拦截** 同类 write / 失败命令重试；
 *     同时仍输出 `RecoverySignal` 注入 user message 提示换策略。
 *   - 支持序列化 / 反序列化，方便 v2 checkpoint 持久化。
 *
 * 运维 / 评测读数（Spell Brigade 等长任务常见误判）：
 *   - **验收失败**：write/edit 已成功，但 `npm test` 等 `run_command` exit≠0 —— 根因通常是
 *     任务难或改法未对准断言，不是 edit 工具坏了。
 *   - **本模块拦截**：同文件 edit 达 fileEditMax（默认 3）后，写工具 **未执行**，telemetry 仍
 *     记 `success: false`（文案含 `[BranchBudget / Blocked]`、`必须先 read_file`）。
 *   - **工具真坏**：patch 对不上、路径不存在等 —— 与 BranchBudget 无关，success:false 且无 Blocked 前缀。
 *   典型链：验收失败 → tool_failure → forced → 本模块拦同文件第 4 次 edit（后果，非独立根因）。
 *
 * 设计文档：docs/长时间连续工作.md §Part 2
 */

import type {
  BranchBudgetSnapshot,
  RecoverySignal,
} from '../types/runtime-checkpoint.js';
import { emptyBranchBudgetSnapshot } from '../types/runtime-checkpoint.js';

/** 默认预算上限（与文档 §Example 对齐） */
export const DEFAULT_BRANCH_BUDGET = {
  /** 同一文件最大编辑次数 */
  fileEditMax: 3,
  /** 同一 shell 命令最大重试次数 */
  commandRetryMax: 2,
  /** 同一诊断 / 错误签名最大重试次数 */
  errorRepeatMax: 3,
} as const;

export interface BranchBudgetLimits {
  fileEditMax: number;
  commandRetryMax: number;
  errorRepeatMax: number;
}

/** shouldBranchRecover() 的返回值 */
export interface BranchRecoverDecision {
  /** 是否应该触发分支恢复 */
  triggered: boolean;
  /** 触发原因（中文短句，便于 RecoverySignal.message 展示） */
  reason?: string;
  /** 触发计数：当前累积值 */
  currentCount?: number;
  /** 触发计数对应的预算上限 */
  limit?: number;
  /** 触发维度 */
  dimension?: 'file_edit' | 'command_retry' | 'error_repeat';
  /** 触发的具体键（文件路径 / 命令 / 错误签名） */
  key?: string;
}

/** Harness 工具执行前硬拦截判定。 */
export interface BranchToolBlockDecision {
  blocked: boolean;
  dimension?: BranchRecoverDecision['dimension'];
  key?: string;
  message?: string;
}

/** 内部签名规范化 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').slice(0, 200);
}

/** 错误签名规范化：去掉行号 / 时间戳等噪声，便于聚合 */
function normalizeErrorSignature(signature: string): string {
  return signature
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z-]+/g, '<ts>')
    .replace(/:\d+:\d+/g, ':<l>:<c>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export class BranchBudgetTracker {
  private fileEdits = new Map<string, number>();
  private commandRetries = new Map<string, number>();
  private errorRepeats = new Map<string, number>();
  private recoverTriggers = 0;
  private enabled = true;
  private readonly limits: BranchBudgetLimits;

  /**
   * @param limits 可选自定义上限；默认使用 DEFAULT_BRANCH_BUDGET。
   */
  constructor(limits: Partial<BranchBudgetLimits> = {}) {
    this.limits = {
      fileEditMax: limits.fileEditMax ?? DEFAULT_BRANCH_BUDGET.fileEditMax,
      commandRetryMax: limits.commandRetryMax ?? DEFAULT_BRANCH_BUDGET.commandRetryMax,
      errorRepeatMax: limits.errorRepeatMax ?? DEFAULT_BRANCH_BUDGET.errorRepeatMax,
    };
  }

  // ─── 记录维度 ───

  /**
   * 记录一次文件编辑。
   * @param path 被编辑的文件路径；空 / undefined 自动忽略。
   * @returns 当前累计编辑次数（用于即时决策）
   */
  recordFileEdit(path: string | undefined | null): number {
    if (!this.enabled) return 0;
    if (!path) return 0;
    const next = (this.fileEdits.get(path) ?? 0) + 1;
    this.fileEdits.set(path, next);
    return next;
  }

  /**
   * 仅在 **run_command 执行失败** 时累加同一规范化命令的失败次数。
   * 成功的同条命令不计入——避免合法重复运行（watch、分段测试）误触预算；
   * 与文档「same shell max 2 retries」一致：按失败重试计次，不按总执行次数。
   *
   * @returns 本次失败计入后的该命令失败累计次数（空命令时返回 0）
   */
  recordFailedCommandAttempt(command: string | undefined | null): number {
    if (!this.enabled) return 0;
    if (!command) return 0;
    const key = normalizeCommand(command);
    const next = (this.commandRetries.get(key) ?? 0) + 1;
    this.commandRetries.set(key, next);
    return next;
  }

  /**
   * 记录一次错误（用工具签名或诊断签名表征）。
   * @returns 同签名累计出现次数
   */
  recordError(signature: string | undefined | null): number {
    if (!this.enabled) return 0;
    if (!signature) return 0;
    const key = normalizeErrorSignature(signature);
    const next = (this.errorRepeats.get(key) ?? 0) + 1;
    this.errorRepeats.set(key, next);
    return next;
  }

  // ─── 决策 ───

  /**
   * 判定是否需要触发分支恢复信号。
   *
   * 任意一个维度超过 limit 即视为需要恢复；
   * 返回首个触发的维度（按 file_edit → command_retry → error_repeat 顺序）。
   *
   * 注意：调用本方法**不消费**计数，调用方应在生成 RecoverySignal 后
   * 调用 `markRecoveryTriggered()` 避免下一轮重复触发。
   */
  /**
   * 工具执行前判定：同一文件已达编辑上限 → 拒绝下一次 write/edit。
   * 与 shouldBranchRecover 不同：在 count === limit 时即拦截（最多允许 limit 次编辑）。
   */
  wouldBlockFileEdit(path: string | undefined | null): boolean {
    if (!this.enabled || !path) return false;
    return (this.fileEdits.get(path) ?? 0) >= this.limits.fileEditMax;
  }

  /**
   * 工具执行前判定：同一命令失败重试达上限 → 拒绝再次 run_command。
   */
  wouldBlockCommandRetry(command: string | undefined | null): boolean {
    if (!this.enabled || !command) return false;
    const key = normalizeCommand(command);
    return (this.commandRetries.get(key) ?? 0) >= this.limits.commandRetryMax;
  }

  /**
   * 统一工具拦截入口（write/edit 与 run_command）。
   * 返回 blocked=true 时不应执行工具，直接把 message 作为 tool_result 回给模型。
   *
   * 注意：blocked 时 harness-tool-executor 仍记 failedCount++ / telemetry success:false，
   * 易与「edit_file 执行器故障」混淆；应以 message 是否含 `[BranchBudget / Blocked]` 区分。
   */
  checkToolBlock(
    toolName: string,
    args: Record<string, unknown>,
    extractPath: (name: string, a: Record<string, unknown>) => string | undefined,
    extractCommand: (a: Record<string, unknown>) => string | undefined,
  ): BranchToolBlockDecision {
    if (!this.enabled) return { blocked: false };

    const path = extractPath(toolName, args);
    if (path && this.wouldBlockFileEdit(path)) {
      const count = this.fileEdits.get(path) ?? 0;
      return {
        blocked: true,
        dimension: 'file_edit',
        key: path,
        message: this.buildFileEditBlockMessage(path, count),
      };
    }

    if (toolName === 'run_command') {
      const command = extractCommand(args);
      if (command && this.wouldBlockCommandRetry(command)) {
        const count = this.commandRetries.get(normalizeCommand(command)) ?? 0;
        return {
          blocked: true,
          dimension: 'command_retry',
          key: command,
          message: this.buildCommandBlockMessage(command, count),
        };
      }
    }

    return { blocked: false };
  }

  /** UI 若截断「read_file」为「rea」，是展示宽度问题，完整工具名即 read_file。 */
  buildFileEditBlockMessage(path: string, currentCount: number): string {
    return [
      `[BranchBudget / Blocked] 工具未执行：${path} 已编辑 ${currentCount} 次（上限 ${this.limits.fileEditMax}）。`,
      '禁止继续修改此文件。必须先 read_file 相关测试 / 设计文档，或改其他路径 / 换工具。',
      'Do not rewrite this file again until you have read the failing test and documented expected vs actual behavior.',
    ].join('\n');
  }

  buildCommandBlockMessage(command: string, failedAttempts: number): string {
    const short = command.length > 120 ? `${command.slice(0, 117)}...` : command;
    return [
      `[BranchBudget / Blocked] 工具未执行：命令失败后已重试 ${failedAttempts} 次（上限 ${this.limits.commandRetryMax}）。`,
      `命令: ${short}`,
      '先 read_file 失败测试与源码，分析断言后再换命令或换修复策略；不要原样重跑。',
    ].join('\n');
  }

  shouldBranchRecover(): BranchRecoverDecision {
    if (!this.enabled) return { triggered: false };
    const fileOver = this.findOverLimit(this.fileEdits, this.limits.fileEditMax);
    if (fileOver) {
      return {
        triggered: true,
        dimension: 'file_edit',
        key: fileOver.key,
        currentCount: fileOver.count,
        limit: this.limits.fileEditMax,
        reason: `同一文件 ${fileOver.key} 已编辑 ${fileOver.count} 次（上限 ${this.limits.fileEditMax}）`,
      };
    }
    const cmdOver = this.findOverLimit(this.commandRetries, this.limits.commandRetryMax);
    if (cmdOver) {
      return {
        triggered: true,
        dimension: 'command_retry',
        key: cmdOver.key,
        currentCount: cmdOver.count,
        limit: this.limits.commandRetryMax,
        reason: `同一命令失败后已累积 ${cmdOver.count} 次（上限 ${this.limits.commandRetryMax}）`,
      };
    }
    const errOver = this.findOverLimit(this.errorRepeats, this.limits.errorRepeatMax);
    if (errOver) {
      return {
        triggered: true,
        dimension: 'error_repeat',
        key: errOver.key,
        currentCount: errOver.count,
        limit: this.limits.errorRepeatMax,
        reason: `同一错误重复出现 ${errOver.count} 次（上限 ${this.limits.errorRepeatMax}）`,
      };
    }
    return { triggered: false };
  }

  /**
   * 生成可注入到对话的 RecoverySignal。
   * 不主动 abort，仅产出一条 user-facing warning。
   *
   * @param decision 来自 shouldBranchRecover() 的判定结果
   * @returns RecoverySignal，未触发时返回 null
   */
  buildRecoverySignal(decision?: BranchRecoverDecision): RecoverySignal | null {
    const d = decision ?? this.shouldBranchRecover();
    if (!d.triggered) return null;
    return {
      source: 'branch_budget',
      message: [
        '[System / Runtime Warning] Current branch exhausted.',
        d.reason ? `原因: ${d.reason}` : '',
        '当前策略已达到分支预算上限。请立刻切换策略：换工具 / 换路径 / 换参数 / 拆分子任务；',
        '不要再原样重试同一操作。若确实无法继续，请向用户说明具体阻塞点与已尝试的证据。',
        'Switch strategy. Do not retry the same failed branch.',
      ].filter(Boolean).join('\n'),
      at: Date.now(),
      consumed: false,
    };
  }

  /** 标记一次 recovery 已触发，用于持久化与去重计数。 */
  markRecoveryTriggered(): void {
    this.recoverTriggers++;
  }

  /**
   * §2.8 / T12 — 由 ExecutionMode 控制启停：forced 才记录 / 触发；
   * free 段不消耗预算也不产出 recovery 文案。disabled 不清空已有计数，
   * 重新启用后保留累积（避免短暂切换后丢失上下文）。
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** 当前是否启用记录与判定。 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 已触发的 recovery 次数 */
  get recoverTriggerCount(): number {
    return this.recoverTriggers;
  }

  /** 调试 / 测试用：返回内部映射的拷贝 */
  inspect(): {
    fileEdits: Record<string, number>;
    commandRetries: Record<string, number>;
    errorRepeats: Record<string, number>;
  } {
    return {
      fileEdits: Object.fromEntries(this.fileEdits),
      commandRetries: Object.fromEntries(this.commandRetries),
      errorRepeats: Object.fromEntries(this.errorRepeats),
    };
  }

  /** 重置全部计数（任务切换时调用） */
  reset(): void {
    this.fileEdits.clear();
    this.commandRetries.clear();
    this.errorRepeats.clear();
    this.recoverTriggers = 0;
  }

  // ─── 持久化 ───

  snapshot(): BranchBudgetSnapshot {
    return {
      fileEdits: Object.fromEntries(this.fileEdits),
      commandRetries: Object.fromEntries(this.commandRetries),
      errorRepeats: Object.fromEntries(this.errorRepeats),
      recoverTriggers: this.recoverTriggers,
    };
  }

  applySnapshot(snapshot: BranchBudgetSnapshot | undefined | null): void {
    const s = snapshot ?? emptyBranchBudgetSnapshot();
    this.fileEdits = new Map(Object.entries(s.fileEdits ?? {}));
    this.commandRetries = new Map(Object.entries(s.commandRetries ?? {}));
    this.errorRepeats = new Map(Object.entries(s.errorRepeats ?? {}));
    this.recoverTriggers = s.recoverTriggers ?? 0;
  }

  static fromSnapshot(
    snapshot: BranchBudgetSnapshot | undefined | null,
    limits?: Partial<BranchBudgetLimits>,
  ): BranchBudgetTracker {
    const t = new BranchBudgetTracker(limits);
    t.applySnapshot(snapshot);
    return t;
  }

  // ─── 内部辅助 ───

  private findOverLimit(
    map: Map<string, number>,
    limit: number,
  ): { key: string; count: number } | null {
    let worst: { key: string; count: number } | null = null;
    for (const [key, count] of map) {
      if (count > limit && (!worst || count > worst.count)) {
        worst = { key, count };
      }
    }
    return worst;
  }
}
