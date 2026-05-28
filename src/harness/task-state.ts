import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import {
  classifyChangedFiles,
  fileDeliverablePaths,
  isFileDeliverableConfirmationTool,
  isNonEmptyFileInfoOutput,
  isNonEmptyReadOutput,
  normalizeDeliverablePath,
  pathsReferToSameFile,
  type DeliverableKind,
} from './document-deliverable.js';
import { isHarnessVerificationCommand } from './verification-digest.js';
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

const FILE_READ_TOOLS = new Set(['read_file', 'open_file', 'search_codebase', 'git', 'file_info']);
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
      const command = String(toolCall.arguments?.command ?? '');
      if (command) this.commandsRun.push(command);
      if (looksLikeVerificationCommand(command)) {
        this.phase = 'verification';
        this.verificationRequired = true;
        this.verificationStatus = result.success ? 'passed' : 'failed';
      }
      return;
    }

    if (!result.success) return;

    if (FILE_READ_TOOLS.has(toolCall.name)) {
      this.phase = this.phase === 'intent' ? 'context' : this.phase;
      const path = extractPathLikeArg(toolCall.arguments);
      if (path) {
        this.filesRead.add(path);
        this.tryConfirmFileDeliverable(toolCall.name, path, result);
      }
    }

    if (FILE_WRITE_TOOLS.has(toolCall.name)) {
      this.phase = 'editing';
      const path = extractPathLikeArg(toolCall.arguments);
      if (path) {
        this.filesChanged.add(path);
        this.bumpFileDeliverableWriteVersion(path);
        this.verificationRequired = true;
        if (this.verificationStatus !== 'failed') {
          this.verificationStatus = 'required';
        }
      }
    }
  }

  deliverableKind(): DeliverableKind {
    return classifyChangedFiles([...this.filesChanged]);
  }

  buildVerificationPrompt(): string {
    const files = [...this.filesChanged];
    const fileList = files.length > 0 ? files.map(f => `- ${f}`).join('\n') : '- (changed files unknown)';

    if (this.verificationStatus === 'failed') {
      if (this.deliverableKind() === 'file_deliverable') {
        return `[System] File deliverable verification failed. The task is not complete.

Changed files:
${fileList}

Use file_info or read_file on each changed file to confirm it exists and is non-empty. Fix or rewrite the deliverable if needed. Do not run npm test for non-engineering file deliverables.`;
      }

      return `[System] Verification failed. The task is not complete.

Changed files:
${fileList}

Read the failure output, fix the code or assets, then rerun verification (npm test, build, lint, or project-specific checks). Do not end the session until verification passes.`;
    }

    if (this.deliverableKind() === 'file_deliverable') {
      return `[System] You changed file deliverables but have not confirmed them yet.

Changed files:
${fileList}

Run file_info (preferred) or read_file on each file above to confirm it exists and is non-empty. Do NOT run npm test, wc, or shell grep for non-engineering file deliverables. Do not claim the task is complete before confirmation.`;
    }

    return `[System] You changed files but has not verified the result yet.

Changed files:
${fileList}

Run an appropriate verification command now (for example: focused tests, npm test, npx tsc --noEmit, lint, or a project-specific check). If verification is impossible, state the exact blocker and evidence. Do not claim the task is complete before verification.`;
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
   * 纯查询：是否应拦截 model_done（无副作用）。
   * 文件交付物全部确认后请先调用 {@link tryMarkFileDeliverablesVerified}。
   */
  isVerificationBlockingFinal(acceptanceIncomplete?: boolean): boolean {
    if (acceptanceIncomplete) return true;
    if (this.verificationStatus === 'passed') return false;
    if (this.verificationStatus === 'failed') return true;

    if (this.deliverableKind() === 'file_deliverable') {
      return !this.areAllFileDeliverablesConfirmed();
    }

    if (this.verificationRequired && this.verificationStatus === 'required') return true;
    if (this.filesChanged.size > 0 && this.verificationStatus !== 'passed') return true;
    return false;
  }

  /** 查询前同步 file_deliverable 验收状态（checkpoint / resilience 用） */
  isVerificationBlockingFinalAfterSync(acceptanceIncomplete?: boolean): boolean {
    this.tryMarkFileDeliverablesVerified();
    return this.isVerificationBlockingFinal(acceptanceIncomplete);
  }

  /** 文件交付物已全部写后确认时，同步 verificationStatus → passed */
  tryMarkFileDeliverablesVerified(): boolean {
    if (this.verificationStatus === 'passed' || this.verificationStatus === 'failed') {
      return this.verificationStatus === 'passed';
    }
    if (this.deliverableKind() !== 'file_deliverable') return false;
    if (!this.areAllFileDeliverablesConfirmed()) return false;
    this.markVerificationPassed();
    return true;
  }

  areAllFileDeliverablesConfirmed(): boolean {
    const paths = fileDeliverablePaths([...this.filesChanged]);
    if (paths.length === 0) return false;
    return paths.every(path => {
      const norm = normalizeDeliverablePath(path);
      const writeVer = this.fileDeliverableWriteVersion.get(norm) ?? 0;
      const confirmVer = this.fileDeliverableConfirmVersion.get(norm) ?? 0;
      return writeVer > 0 && confirmVer === writeVer;
    });
  }

  /** verification gate 熔断：写后版本均已确认时自动 passed */
  reconcileFileDeliverablesAfterWrite(): boolean {
    if (this.deliverableKind() !== 'file_deliverable') return false;
    if (!this.areAllFileDeliverablesConfirmed()) return false;
    this.markVerificationPassed();
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
    if (this.deliverableKind() !== 'file_deliverable') return;
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
    if (this.areAllFileDeliverablesConfirmed()) {
      this.markVerificationPassed();
    }
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
    if (this.fileDeliverableWriteVersion.size === 0 && this.deliverableKind() === 'file_deliverable') {
      for (const path of fileDeliverablePaths([...this.filesChanged])) {
        const norm = normalizeDeliverablePath(path);
        this.fileDeliverableWriteVersion.set(norm, 1);
        if (snapshot.verificationStatus === 'passed') {
          this.fileDeliverableConfirmVersion.set(norm, 1);
        }
      }
    }
  }
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
  return isHarnessVerificationCommand(command);
}
