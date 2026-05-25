import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
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
      if (path) this.filesRead.add(path);
    }

    if (FILE_WRITE_TOOLS.has(toolCall.name)) {
      this.phase = 'editing';
      const path = extractPathLikeArg(toolCall.arguments);
      if (path) this.filesChanged.add(path);
      this.verificationRequired = true;
      if (this.verificationStatus !== 'failed') {
        this.verificationStatus = 'required';
      }
    }
  }

  shouldBlockFinalForVerification(): boolean {
    if (this.verificationStatus === 'failed') return true;
    if (this.verificationRequired && this.verificationStatus === 'required') return true;
    if (this.filesChanged.size > 0 && this.verificationStatus !== 'passed') {
      this.verificationRequired = true;
      return true;
    }
    return false;
  }

  buildVerificationPrompt(): string {
    const files = [...this.filesChanged];
    const fileList = files.length > 0 ? files.map(f => `- ${f}`).join('\n') : '- (changed files unknown)';

    if (this.verificationStatus === 'failed') {
      return `[System] Verification failed. The task is not complete.

Changed files:
${fileList}

Read the failure output, fix the code or assets, then rerun verification (npm test, build, lint, or project-specific checks). Do not end the session until verification passes.`;
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

  snapshot(): TaskStateSnapshot {
    return {
      goal: this.goal,
      intent: this.intent,
      phase: this.phase,
      filesRead: [...this.filesRead],
      filesChanged: [...this.filesChanged],
      commandsRun: [...this.commandsRun],
      verificationRequired: this.verificationRequired,
      verificationStatus: this.verificationStatus,
    };
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
  }
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
