import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
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
      if (isExecutableIntent(this.intent)) {
        this.verificationRequired = true;
        this.verificationStatus = 'required';
      }
    }

    if (toolCall.name === 'run_command') {
      const command = String(toolCall.arguments?.command ?? '');
      if (command) this.commandsRun.push(command);
      if (looksLikeVerificationCommand(command)) {
        this.phase = 'verification';
        this.verificationStatus = result.success ? 'passed' : 'failed';
      }
    }
  }

  shouldBlockFinalForVerification(): boolean {
    return this.verificationRequired && this.verificationStatus === 'required';
  }

  buildVerificationPrompt(): string {
    const files = [...this.filesChanged];
    const fileList = files.length > 0 ? files.map(f => `- ${f}`).join('\n') : '- (changed files unknown)';
    return `[System] You changed files but has not verified the result yet.

Changed files:
${fileList}

Run an appropriate verification command now (for example: focused tests, npm test, npx tsc --noEmit, lint, or a project-specific check). If verification is impossible, state the exact blocker and evidence. Do not claim the task is complete before verification.`;
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

/** 由用户自然语言推断任务意图（与 TaskState 构造逻辑一致，供执行计划等复用） */
export function inferIntent(text: string): TaskIntent {
  const t = text.toLowerCase();
  if (/测试|运行|verify|test|vitest|jest|pytest|tsc/.test(t)) return 'test';
  if (/修复|失败|报错|错误|debug|fix|investigate/.test(t)) return 'debug';
  if (/重构|refactor/.test(t)) return 'refactor';
  if (/文档|readme|docs?/.test(t)) return 'docs';
  if (/修改|改|实现|新增|创建|edit|modify|implement|create|update/.test(t)) return 'edit';
  if (/查看|读取|搜索|解释|说明|read|search|explain|inspect/.test(t)) return 'inspect';
  return 'question';
}

function isExecutableIntent(intent: TaskIntent): boolean {
  return intent === 'edit' || intent === 'debug' || intent === 'test' || intent === 'refactor';
}

function extractPathLikeArg(args: Record<string, any>): string | undefined {
  for (const key of ['path', 'filePath', 'file_path', 'target_file', 'targetFile']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function looksLikeVerificationCommand(command: string): boolean {
  const c = command.toLowerCase();
  return /\b(npm|pnpm|yarn)\s+(run\s+)?(test|lint|build|typecheck|check)\b/.test(c)
    || /\b(vitest|jest|mocha|pytest|go test|cargo test|npx tsc|tsc --noemit|tsc --noemit|tsc --no-emit|tsc --noEmit)\b/i.test(command)
    || /\b(lint|typecheck|test)\b/.test(c);
}
