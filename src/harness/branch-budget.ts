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
 *   - **本模块拦截**：同文件 edit 达 fileEditMax（默认 3）后，写工具 **未执行**（telemetry 仍
 *     记 `success: false`）。file/command/error 三维计数在 **每次用户发送** 与 **每轮 harness 工具轮**
 *     开始时归零（不继承 checkpoint 计数）。
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
import { isHarnessVerificationCommand } from './verification-digest.js';
import { workspaceFileExists } from './workspace-path-guard.js';
import {
  canonicalBudgetPath,
  mergeBudgetPathMap,
  mergeBudgetPathSet,
} from './branch-budget-path.js';

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
  /** 平台 escalation 授予的单次 write 豁免（路径 → 待消费） */
  private writeBypassPaths = new Set<string>();
  /** 平台 escalation 授予的单次验收命令重试豁免（规范化命令 → 待消费） */
  private commandRetryBypassKeys = new Set<string>();
  private enabled = true;
  private readonly limits: BranchBudgetLimits;
  private budgetWorkspaceRoot?: string;

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

  /** 绑定 workspace 并合并绝对/相对路径下的重复计数。 */
  bindWorkspaceRoot(workspaceRoot: string | undefined): void {
    if (!workspaceRoot?.trim()) return;
    const root = workspaceRoot.trim();
    if (this.budgetWorkspaceRoot === root) return;
    this.budgetWorkspaceRoot = root;
    this.fileEdits = mergeBudgetPathMap(this.fileEdits, root);
    this.writeBypassPaths = mergeBudgetPathSet(this.writeBypassPaths, root);
  }

  private budgetKey(rawPath: string | undefined | null): string | undefined {
    return canonicalBudgetPath(this.budgetWorkspaceRoot, rawPath);
  }

  // ─── 记录维度 ───

  /**
   * 记录一次文件编辑。
   * @param path 被编辑的文件路径；空 / undefined 自动忽略。
   * @returns 当前累计编辑次数（用于即时决策）
   */
  recordFileEdit(path: string | undefined | null): number {
    if (!this.enabled) return 0;
    const key = this.budgetKey(path);
    if (!key) return 0;
    const next = (this.fileEdits.get(key) ?? 0) + 1;
    this.fileEdits.set(key, next);
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
    const key = this.budgetKey(path);
    if (!key) return false;
    if (this.writeBypassPaths.has(key)) return false;
    return (this.fileEdits.get(key) ?? 0) >= this.limits.fileEditMax;
  }

  /**
   * 连续失败 escalation 后授予目标路径一次 write/edit 机会（即使已达 fileEditMax）。
   * 仅在下次对该路径的写工具通过 checkToolBlock 时消费。
   */
  grantWriteBypass(path: string | undefined | null): void {
    const key = this.budgetKey(path);
    if (!key) return;
    this.writeBypassPaths.add(key);
  }

  /** 验收失败等多文件卡死时批量授予一次 write 机会（每路径各一次）。 */
  grantWriteBypassMany(paths: Iterable<string | undefined | null>): string[] {
    const granted: string[] = [];
    for (const raw of paths) {
      const key = this.budgetKey(raw);
      if (!key || !this.wouldBlockFileEdit(raw)) continue;
      this.writeBypassPaths.add(key);
      granted.push(key);
    }
    return granted;
  }

  /** 测试 / 诊断：是否仍持有未消费的 write 豁免 */
  hasWriteBypass(path: string): boolean {
    const key = this.budgetKey(path) ?? path.replace(/\\/g, '/');
    return this.writeBypassPaths.has(key);
  }

  /**
   * 工具执行前判定：同一命令失败重试达上限 → 拒绝再次 run_command。
   */
  wouldBlockCommandRetry(command: string | undefined | null): boolean {
    if (!this.enabled || !command) return false;
    const key = normalizeCommand(command);
    if (this.commandRetryBypassKeys.has(key)) return false;
    return (this.commandRetries.get(key) ?? 0) >= this.limits.commandRetryMax;
  }

  /**
   * 连续失败 escalation 后授予验收命令一次 run_command 机会（即使已达 commandRetryMax）。
   */
  grantCommandRetryBypass(command: string | undefined | null): void {
    if (!command) return;
    this.commandRetryBypassKeys.add(normalizeCommand(command));
  }

  hasCommandRetryBypass(command: string): boolean {
    return this.commandRetryBypassKeys.has(normalizeCommand(command));
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
    context?: { workspaceRoot?: string },
  ): BranchToolBlockDecision {
    if (!this.enabled) return { blocked: false };

    const path = extractPath(toolName, args);
    const key = path ? this.budgetKey(path) : undefined;
    if (key && (this.fileEdits.get(key) ?? 0) >= this.limits.fileEditMax) {
      if (this.writeBypassPaths.delete(key)) {
        return { blocked: false };
      }

      const workspaceRoot = context?.workspaceRoot ?? this.budgetWorkspaceRoot;
      if (
        workspaceRoot
        && toolName === 'write_file'
        && path
        && !workspaceFileExists(workspaceRoot, path)
      ) {
        return { blocked: false };
      }

      const count = this.fileEdits.get(key) ?? 0;
      const fileExists = workspaceRoot && path
        ? workspaceFileExists(workspaceRoot, path)
        : true;
      const pendingBypass = this.writeBypassPaths.has(key);
      return {
        blocked: true,
        dimension: 'file_edit',
        key,
        message: this.buildFileEditBlockMessage(key, count, fileExists, pendingBypass),
      };
    }

    if (toolName === 'run_command') {
      const command = extractCommand(args);
      if (command) {
        const key = normalizeCommand(command);
        if ((this.commandRetries.get(key) ?? 0) >= this.limits.commandRetryMax) {
          if (this.commandRetryBypassKeys.delete(key)) {
            return { blocked: false };
          }
          const count = this.commandRetries.get(key) ?? 0;
          return {
            blocked: true,
            dimension: 'command_retry',
            key: command,
            message: this.buildCommandBlockMessage(command, count),
          };
        }
      }
    }

    return { blocked: false };
  }

  /** UI 若截断「read_file」为「rea」，是展示宽度问题，完整工具名即 read_file。 */
  buildFileEditBlockMessage(
    path: string,
    currentCount: number,
    fileExists = true,
    pendingBypass = false,
  ): string {
    if (!fileExists) {
      return [
        `[BranchBudget / Blocked] 工具未执行：${path} 编辑计数 ${currentCount} 次（上限 ${this.limits.fileEditMax}），但磁盘上不存在该文件（多为 patch 失败仍计次）。`,
        '用 write_file 写入完整文件以创建；可参考同目录已有文件作模板。',
        '禁止 read_file / patch_file / edit_file 此路径。若见 [System / Rebuild Escalation]，按其中 write_file 步骤执行。',
        'Do NOT read or patch a missing path — use write_file (full body) or wait for Rebuild write bypass.',
      ].join('\n');
    }

    const bypassHint = pendingBypass
      ? 'Platform has granted one pending write_file bypass for this path — your NEXT write_file to this path will be allowed once.'
      : 'Rebuild write bypass already used or not granted — do NOT retry write/edit/patch on this path until verification passes or a new [Rebuild Escalation] grants bypass.';

    return [
      `[BranchBudget / Blocked] 工具未执行：${path} 已编辑 ${currentCount} 次（上限 ${this.limits.fileEditMax}）。`,
      bypassHint,
      'Read failing e2e/test output first; fix only what verification requires. Do not bulk-rewrite capped scene files without bypass.',
      'Do not rewrite this file again until you have read the failing test and documented expected vs actual behavior.',
    ].join('\n');
  }

  buildCommandBlockMessage(command: string, failedAttempts: number): string {
    const short = command.length > 120 ? `${command.slice(0, 117)}...` : command;
    return [
      `[BranchBudget / Blocked] 工具未执行：该命令已失败 ${failedAttempts} 次（拦截阈值 ${this.limits.commandRetryMax}）。`,
      `命令: ${short}`,
      '先 read_file 失败输出中引用的源码/测试，分析错误后再改代码；可用 npx tsc --noEmit 收集编译错误。不要原样重跑 build/test。',
      'Do not rerun the same command until you have new evidence from source or compiler output.',
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
    this.writeBypassPaths.clear();
    this.commandRetryBypassKeys.clear();
  }

  /**
   * 新用户消息 / 新 harness 工具轮 — file/command/error 三维计数与豁免归零。
   * recoverTriggers 保留（跨轮 recovery 去重用）。
   */
  resetRoundBudget(): void {
    this.fileEdits.clear();
    this.commandRetries.clear();
    this.errorRepeats.clear();
    this.writeBypassPaths.clear();
    this.commandRetryBypassKeys.clear();
  }

  /** @deprecated 使用 resetRoundBudget */
  resetFileEditBudget(): void {
    this.resetRoundBudget();
  }

  /**
   * Segment Renewal / 续段后：清除验收命令失败计数，保留文件编辑计数。
   */
  resetCommandRetriesForVerificationCommands(): void {
    for (const [key] of [...this.commandRetries.entries()]) {
      if (isHarnessVerificationCommand(key)) {
        this.commandRetries.delete(key);
      }
    }
    this.commandRetryBypassKeys.clear();
  }

  // ─── 持久化 ───

  snapshot(): BranchBudgetSnapshot {
    return {
      fileEdits: Object.fromEntries(this.fileEdits),
      commandRetries: Object.fromEntries(this.commandRetries),
      errorRepeats: Object.fromEntries(this.errorRepeats),
      recoverTriggers: this.recoverTriggers,
      writeBypassPaths: this.writeBypassPaths.size > 0
        ? [...this.writeBypassPaths]
        : undefined,
      commandRetryBypassKeys: this.commandRetryBypassKeys.size > 0
        ? [...this.commandRetryBypassKeys]
        : undefined,
    };
  }

  applySnapshot(snapshot: BranchBudgetSnapshot | undefined | null): void {
    const s = snapshot ?? emptyBranchBudgetSnapshot();
    this.fileEdits = new Map(Object.entries(s.fileEdits ?? {}));
    this.commandRetries = new Map(Object.entries(s.commandRetries ?? {}));
    this.errorRepeats = new Map(Object.entries(s.errorRepeats ?? {}));
    this.recoverTriggers = s.recoverTriggers ?? 0;
    this.writeBypassPaths = new Set(s.writeBypassPaths ?? []);
    this.commandRetryBypassKeys = new Set(s.commandRetryBypassKeys ?? []);
    if (this.budgetWorkspaceRoot) {
      this.fileEdits = mergeBudgetPathMap(this.fileEdits, this.budgetWorkspaceRoot);
      this.writeBypassPaths = mergeBudgetPathSet(this.writeBypassPaths, this.budgetWorkspaceRoot);
    }
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
