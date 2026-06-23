import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import {
  classifyChangedFiles,
  engineeringTestTargetPaths,
  extractDeletedPathsFromCommand,
  deliverableVersionFromMap,
  gateConfirmationPaths,
  hasUnconfirmedFileDeliverables,
  isFileDeliverableConfirmationTool,
  isMissingFileToolResult,
  isNonEmptyFileInfoOutput,
  isNonEmptyReadOutput,
  missingChangedFilePaths,
  normalizeDeliverablePath,
  pathsReferToSameFile,
  hasEngineeringTestTargets,
  isEngineeringUnitTestTargetPath,
  shouldInjectFailedUnitTestReminder,
  shouldPromptEngineeringUnitTest,
  writeConfirmationPaths,
  type DeliverableKind,
} from './document-deliverable.js';
import { classifyRunCommandResult } from './task-acceptance-tracker.js';
import { isUnitTestVerificationCommand } from './verification-digest.js';
import type {
  TaskIntent,
  TaskPhase,
  TaskStateSnapshot,
  VerificationStatus,
} from '../types/runtime-snapshot.js';

export type {
  TaskIntent,
  TaskPhase,
  TaskStateSnapshot,
  VerificationStatus,
} from '../types/runtime-snapshot.js';

const FILE_READ_TOOLS = new Set(['read_file', 'open_file', 'glob', 'grep', 'git', 'file_info']);
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'batch_edit_file', 'patch_file']);

export class TaskState {
  private goal: string;
  private intent: TaskIntent;
  private phase: TaskPhase = 'intent';
  private filesRead = new Set<string>();
  private filesChanged = new Set<string>();
  private commandsRun: string[] = [];
  private verificationRequired = false;
  private verificationStatus: VerificationStatus = 'not_required';
  /** 文件交付物写操作版本（归一化路径 → 版本号，写后递增） */
  private fileDeliverableWriteVersion = new Map<string, number>();
  /** 文件交付物确认时对应的写版本（须与 writeVersion 一致才算验收） */
  private fileDeliverableConfirmVersion = new Map<string, number>();

  constructor(goal: string) {
    this.goal = goal;
    this.intent = inferIntent(goal);
  }

  recordToolResult(toolCall: ToolCall, result: ToolResult): void {
    if (toolCall.name === 'run_command') {
      const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
      const command = String(args.command ?? args.cmd ?? '');
      const rawOutput = `${result.output ?? ''}`;
      const classified = classifyRunCommandResult(args, rawOutput, result.success);
      const effectiveCommand = classified?.command ?? command;
      if (effectiveCommand) {
        this.commandsRun.push(effectiveCommand);
        if (looksLikeVerificationCommand(effectiveCommand)) {
          this.phase = 'verification';
          this.verificationRequired = true;
          this.applyUnitTestVerificationFromRunResult(args, effectiveCommand, result);
        }
        if (result.success) {
          for (const deletedPath of extractDeletedPathsFromCommand(effectiveCommand)) {
            this.removeChangedFileDeliverable(deletedPath);
          }
        }
      }
      return;
    }

    if (toolCall.name === 'fs_operation') {
      const op = String(toolCall.arguments?.operation ?? '');
      if (op === 'delete' && result.success) {
        const path = extractPathLikeArg(toolCall.arguments);
        if (path) this.removeChangedFileDeliverable(path);
      }
      return;
    }

    const path = extractPathLikeArg(toolCall.arguments);
    if (
      !result.success
      && path
      && FILE_READ_TOOLS.has(toolCall.name)
      && isMissingFileToolResult(result)
    ) {
      this.removeChangedFileDeliverable(path);
      return;
    }

    if (!result.success) return;

    if (FILE_READ_TOOLS.has(toolCall.name)) {
      this.phase = this.phase === 'intent' ? 'context' : this.phase;
      if (path) {
        this.filesRead.add(path);
        this.tryConfirmFileDeliverable(toolCall.name, path, result);
      }
    }

    if (FILE_WRITE_TOOLS.has(toolCall.name)) {
      this.phase = 'editing';
      if (path) {
        this.filesChanged.add(path);
        this.bumpFileDeliverableWriteVersion(path);
        this.verificationRequired = true;
        this.verificationStatus = 'required';
      }
    }
  }

  /** 按 run_command 真实完成态更新单测验收（跳过后台启动 / 运行中） */
  private applyUnitTestVerificationFromRunResult(
    args: Record<string, unknown>,
    _command: string,
    result: ToolResult,
  ): void {
    const rawOutput = `${result.output ?? ''}`;
    const classified = classifyRunCommandResult(args, rawOutput, result.success);
    if (classified) {
      switch (classified.kind) {
        case 'background_start':
        case 'background_running':
          if (this.verificationStatus !== 'passed') {
            this.verificationStatus = 'required';
          }
          return;
        case 'background_completed':
          this.verificationStatus = (classified.exitCode ?? 0) === 0 ? 'passed' : 'failed';
          return;
        case 'background_failed':
          this.verificationStatus = 'failed';
          return;
        case 'foreground':
          this.verificationStatus = classified.foregroundSuccess ? 'passed' : 'failed';
          return;
        default:
          break;
      }
    }
    this.verificationStatus = result.success ? 'passed' : 'failed';
  }

  deliverableKind(): DeliverableKind {
    return classifyChangedFiles([...this.filesChanged]);
  }

  buildVerificationPrompt(): string {
    const targets = engineeringTestTargetPaths([...this.filesChanged]);
    const maxList = 12;
    const listed = targets.slice(0, maxList);
    const fileList = listed.length > 0
      ? listed.map(f => `- ${f}`).join('\n')
      : '- (no engineering source paths — skip unit tests)';
    const more = targets.length > maxList
      ? `\n- … and ${targets.length - maxList} more`
      : '';

    return `[System] You changed source code but have not run unit tests yet.

Before finishing, consider running unit tests for these changed files (pick the command for this project — mvn test, pytest, go test, cargo test, npm test, etc.):
${fileList}${more}

If you're confident the changes are correct and low-risk, you may finish with a brief note. Otherwise use run_command to verify and fix any failures.`;
  }

  buildFailedUnitTestReminderPrompt(): string {
    const targets = engineeringTestTargetPaths([...this.filesChanged]);
    const maxList = 8;
    const listed = targets.slice(0, maxList);
    const fileList = listed.map(f => `- ${f}`).join('\n');
    const more = targets.length > maxList
      ? `\n- … and ${targets.length - maxList} more`
      : '';

    return `[System] Unit tests failed for your recent changes.

If you can fix them, re-run tests via run_command and address failures. If not, you may finish — but state the failure plainly in your summary.

Changed source files:
${fileList}${more}`;
  }

  /** 模型在 Verification Gate 提醒后选择不跑测收尾 */
  markVerificationWaived(): void {
    if (this.verificationStatus === 'required') {
      this.verificationStatus = 'not_required';
    }
  }

  /** filesChanged 中缺少 writeVersion 的路径补版本（checkpoint 恢复或历史审计遗留） */
  reconcileOrphanFileDeliverableWriteVersions(workspaceRoot?: string): number {
    let fixed = 0;
    for (const path of gateConfirmationPaths(
      [...this.filesChanged],
      workspaceRoot,
      mapToVersionRecord(this.fileDeliverableWriteVersion),
      mapToVersionRecord(this.fileDeliverableConfirmVersion),
    )) {
      const norm = normalizeDeliverablePath(path);
      if ((this.fileDeliverableWriteVersion.get(norm) ?? 0) !== 0) continue;
      this.fileDeliverableWriteVersion.set(
        norm,
        resolveOrphanWriteVersion(this.fileDeliverableConfirmVersion, path),
      );
      fixed++;
    }
    return fixed;
  }

  pendingFileDeliverableCount(workspaceRoot?: string): number {
    return this.isVerificationBlockingFinal(false, workspaceRoot) ? 1 : 0;
  }

  /** 续跑时覆盖被「继续」污染的 goal/intent */
  rebindGoal(goal: string): void {
    this.goal = goal;
    this.intent = inferIntent(goal);
  }

  /** 与 RepoContext.recentDiagnostics 对齐 */
  forceVerificationFailed(): void {
    this.verificationRequired = true;
    this.verificationStatus = 'failed';
    if (this.filesChanged.size > 0) {
      this.phase = 'verification';
    }
  }

  /** Acceptance Gate：全部验收命令通过后同步为 passed。 */
  markVerificationPassed(): void {
    this.verificationRequired = true;
    this.verificationStatus = 'passed';
    this.phase = 'verification';
  }

  /** Acceptance Gate：仍有未跑或未过的验收命令。 */
  markVerificationRequired(): void {
    this.verificationRequired = true;
    if (this.verificationStatus !== 'failed') {
      this.verificationStatus = 'required';
    }
  }

  /**
   * 纯查询：是否应 inject 单元测试提示并 continue（无副作用）。
   * Acceptance Gate 或工程变更未跑单测时可 block；测失败不 block（仅加强提示）。
   */
  isVerificationBlockingFinal(acceptanceIncomplete?: boolean, workspaceRoot?: string): boolean {
    if (acceptanceIncomplete) return true;
    return shouldPromptEngineeringUnitTest(
      [...this.filesChanged],
      this.verificationStatus,
    );
  }

  /** 查询前同步（checkpoint / resilience 用） */
  isVerificationBlockingFinalAfterSync(
    acceptanceIncomplete?: boolean,
    workspaceRoot?: string,
  ): boolean {
    return this.isVerificationBlockingFinal(acceptanceIncomplete, workspaceRoot);
  }

  areAllFileDeliverablesConfirmed(workspaceRoot?: string): boolean {
    return !hasUnconfirmedFileDeliverables(
      [...this.filesChanged],
      mapToVersionRecord(this.fileDeliverableWriteVersion),
      mapToVersionRecord(this.fileDeliverableConfirmVersion),
      workspaceRoot,
    );
  }

  /** verification gate 熔断：工程变更均已测过时不 block */
  reconcileFileDeliverablesAfterWrite(_workspaceRoot?: string): boolean {
    return !shouldPromptEngineeringUnitTest(
      [...this.filesChanged],
      this.verificationStatus,
    );
  }

  shouldInjectFailedUnitTestReminder(): boolean {
    return shouldInjectFailedUnitTestReminder(
      [...this.filesChanged],
      this.verificationStatus,
    );
  }

  /** 本轮是否成功写入工程源码（供 Harness 重置失败提醒） */
  isEngineeringWriteToolCall(toolCall: ToolCall, result: ToolResult): boolean {
    if (!result.success) return false;
    const writeTools = new Set(['write_file', 'edit_file', 'append_file', 'batch_edit_file', 'patch_file']);
    if (!writeTools.has(toolCall.name)) return false;
    const path = extractPathLikeArg(toolCall.arguments);
    if (!path) return false;
    return isEngineeringUnitTestTargetPath(path);
  }

  /**
   * 清理已删除的变更路径（cleanup 脚本 / fs delete 后磁盘不存在）。
   * 返回移除的路径数。
   */
  reconcileMissingChangedFiles(workspaceRoot?: string): number {
    const missing = missingChangedFilePaths(
      [...this.filesChanged],
      workspaceRoot,
      mapToVersionRecord(this.fileDeliverableWriteVersion),
      mapToVersionRecord(this.fileDeliverableConfirmVersion),
    );
    let removed = 0;
    for (const path of missing) {
      if (this.removeChangedFileDeliverable(path)) removed++;
    }
    return removed;
  }

  private removeChangedFileDeliverable(path: string): boolean {
    const matched = [...this.filesChanged].find(changed => pathsReferToSameFile(changed, path));
    if (!matched) return false;

    const norm = normalizeDeliverablePath(matched);
    this.filesChanged.delete(matched);
    this.fileDeliverableWriteVersion.delete(norm);
    this.fileDeliverableConfirmVersion.delete(norm);

    if (this.filesChanged.size === 0) {
      if (this.verificationStatus === 'required') {
        this.verificationStatus = 'not_required';
      }
    } else if (!hasEngineeringTestTargets([...this.filesChanged])) {
      if (this.verificationStatus === 'required') {
        this.verificationStatus = 'not_required';
      }
    }
    return true;
  }

  private bumpFileDeliverableWriteVersion(path: string): void {
    const norm = normalizeDeliverablePath(path);
    const next = (this.fileDeliverableWriteVersion.get(norm) ?? 0) + 1;
    this.fileDeliverableWriteVersion.set(norm, next);
    this.fileDeliverableConfirmVersion.delete(norm);
    if (this.verificationStatus === 'passed') {
      this.verificationStatus = 'required';
    }
  }

  private tryConfirmFileDeliverable(
    toolName: string,
    path: string,
    result: ToolResult,
  ): void {
    if (!isFileDeliverableConfirmationTool(toolName)) return;

    const matched = [...this.filesChanged].find(changed => pathsReferToSameFile(changed, path));
    if (!matched) return;

    const norm = normalizeDeliverablePath(matched);
    const writeVer = this.fileDeliverableWriteVersion.get(norm) ?? 0;
    if (writeVer === 0) return;

    const confirmed =
      toolName === 'file_info'
        ? isNonEmptyFileInfoOutput(result.output)
        : isNonEmptyReadOutput(result.output);
    if (!confirmed) return;

    this.fileDeliverableConfirmVersion.set(norm, writeVer);
  }

  snapshot(): TaskStateSnapshot {
    const snap: TaskStateSnapshot = {
      goal: this.goal,
      intent: this.intent,
      phase: this.phase,
      filesRead: [...this.filesRead],
      filesChanged: [...this.filesChanged],
      commandsRun: [...this.commandsRun],
      verificationRequired: this.verificationRequired,
      verificationStatus: this.verificationStatus,
    };
    const writeVersions = mapToVersionRecord(this.fileDeliverableWriteVersion);
    const confirmVersions = mapToVersionRecord(this.fileDeliverableConfirmVersion);
    if (writeVersions) snap.fileDeliverableWriteVersions = writeVersions;
    if (confirmVersions) snap.fileDeliverableConfirmVersions = confirmVersions;
    return snap;
  }

  /**
   * 从持久化快照恢复（会话笔记中的 JSON）。用于长会话重启后继续同一任务。
   */
  applySnapshot(snapshot: TaskStateSnapshot): void {
    this.goal = snapshot.goal;
    this.intent = snapshot.intent;
    this.phase = snapshot.phase;
    this.filesRead = new Set(snapshot.filesRead);
    this.filesChanged = new Set(snapshot.filesChanged);
    this.commandsRun = [...snapshot.commandsRun];
    this.verificationRequired = snapshot.verificationRequired;
    this.verificationStatus = snapshot.verificationStatus;
    this.fileDeliverableWriteVersion = recordToVersionMap(snapshot.fileDeliverableWriteVersions);
    this.fileDeliverableConfirmVersion = recordToVersionMap(snapshot.fileDeliverableConfirmVersions);
    if (this.fileDeliverableWriteVersion.size === 0) {
      for (const path of writeConfirmationPaths([...this.filesChanged])) {
        const norm = normalizeDeliverablePath(path);
        this.fileDeliverableWriteVersion.set(
          norm,
          resolveOrphanWriteVersion(this.fileDeliverableConfirmVersion, path),
        );
        if (snapshot.verificationStatus === 'passed') {
          this.fileDeliverableConfirmVersion.set(norm, 1);
        }
      }
    }
    this.reconcileOrphanFileDeliverableWriteVersions();
  }
}

function resolveOrphanWriteVersion(
  confirmVersions: Map<string, number>,
  path: string,
): number {
  const confirmVer = deliverableVersionFromMap(confirmVersions, path);
  // 已有 confirm 但缺 write → 升一档 write，强制重新 file_info/read（避免恢复态假确认）
  if (confirmVer > 0) return confirmVer + 1;
  return 1;
}

function mapToVersionRecord(map: Map<string, number>): Record<string, number> | undefined {
  if (map.size === 0) return undefined;
  return Object.fromEntries(map);
}

function recordToVersionMap(record: Record<string, number> | undefined): Map<string, number> {
  if (!record) return new Map();
  return new Map(Object.entries(record));
}

/** 纯分析/疑问口吻（无明确「请改/请跑测」侧信号） */
function isQuestionOnlyPrefix(text: string): boolean {
  const rawTrim = text.trim();
  const t = rawTrim.toLowerCase();
  return rawTrim.startsWith('分析一下')
    || rawTrim.startsWith('说明一下')
    || rawTrim.startsWith('解释一下')
    || rawTrim.startsWith('为什么')
    || rawTrim.startsWith('如何')
    || rawTrim.startsWith('怎么')
    || /^解释([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^说明([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^分析([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^(what|why|how)\b/i.test(t);
}

/** edit 同义：实现、新增、创建、生成（与下方 inferIntent 分支一致） */
const EDIT_GOAL_CN = /修改|改|编辑|实现|新增|创建|生成/;

/** 明确要动工具/改代码/跑测的信号（不含单独「报错」等分析词） */
export function hasExecutableSideSignal(text: string): boolean {
  const t = text.toLowerCase();
  return EDIT_GOAL_CN.test(t)
    || /运行\s*测试|跑测试|vitest|jest|pytest|mocha/i.test(t)
    || /\b(edit|modify|implement|create|update|fix|investigate|refactor)\b/i.test(t)
    || /\b(run|execute)\s+\S+/i.test(t)
    || /(?:^|[\s,;])(?:npm|pnpm|yarn|npx)\s+\S*test\b/i.test(t);
}

/** 由用户自然语言推断任务意图（与 TaskState 构造逻辑一致，供执行计划等复用） */
export function inferIntent(text: string): TaskIntent {
  const t = text.toLowerCase();
  const rawTrim = text.trim();

  if (isQuestionOnlyPrefix(text) && !hasExecutableSideSignal(text)) {
    if (/查看|读取|搜索|解释|说明|read|search|explain|inspect/.test(t)) return 'inspect';
    return 'question';
  }

  // 实现 / 新增 / 创建 / 生成 同义 → edit（避免路径中含 test 被误判为跑测）
  if (EDIT_GOAL_CN.test(t) || /\b(edit|modify|implement|create|update)\b/.test(t)) return 'edit';
  if (/测试|运行\s*测试|跑测试|verify|(?:^|[\s,;])(?:npm|pnpm|yarn|npx)\s+\S*test\b|vitest|jest|pytest|\btsc\b/.test(t)) {
    return 'test';
  }
  if (/修复|失败|报错|错误|debug|fix|investigate/.test(t)) return 'debug';
  if (/重构|refactor/.test(t)) return 'refactor';
  if (/文档|readme|docs?/.test(t)) return 'docs';
  if (/查看|读取|搜索|解释|说明|read|search|explain|inspect/.test(t)) return 'inspect';
  return 'question';
}

function extractPathLikeArg(args: Record<string, any>): string | undefined {
  for (const key of ['path', 'filePath', 'file_path', 'target_file', 'targetFile']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function looksLikeVerificationCommand(command: string): boolean {
  return isUnitTestVerificationCommand(command);
}
