import { isHarnessVerificationCommand } from './verification-digest.js';

export interface VerificationOutputEntry {
  command: string;
  outputBody: string;
  at: number;
}

const MAX_ENTRIES = 3;

function stripToolErrorPrefix(content: string): string {
  return content.replace(/^(?:工具执行错误|Tool execution error)[:：][^\n]*\n+/m, '').trim();
}

/** 保留最近若干条验收命令失败输出，compaction / BranchBudget block 后仍可注入 digest。 */
export class VerificationOutputBuffer {
  private entries: VerificationOutputEntry[] = [];

  recordFailed(command: string, rawOutput: string): void {
    const normalized = command.trim();
    if (!normalized || !isHarnessVerificationCommand(normalized)) return;

    const outputBody = stripToolErrorPrefix(rawOutput);
    if (!outputBody) return;

    this.entries.push({
      command: normalized,
      outputBody,
      at: Date.now(),
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  findLastFailed(preferredCommand?: string | null): VerificationOutputEntry | null {
    if (preferredCommand) {
      const key = preferredCommand.trim().replace(/\s+/g, ' ').slice(0, 200);
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const entry = this.entries[i];
        const entryKey = entry.command.trim().replace(/\s+/g, ' ').slice(0, 200);
        if (entryKey === key) return entry;
      }
    }

    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  snapshot(): VerificationOutputEntry[] {
    return this.entries.map(entry => ({ ...entry }));
  }

  restore(entries: VerificationOutputEntry[] | undefined): void {
    this.entries = (entries ?? []).slice(-MAX_ENTRIES).map(entry => ({ ...entry }));
  }

  clear(): void {
    this.entries = [];
  }
}

/** 从 delegate 任务文案中提取可能触发 diagnostic gate 的 run_command。 */
export function extractBuildLikeCommandsFromText(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bnpm\s+run\s+build\b[^;\n]*/gi,
    /\bnpm\s+run\s+test:e2e\b[^;\n]*/gi,
    /\bnode\s+[^\n;]*vite[^\n;]*build\b/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const cmd = match[0].trim();
      if (cmd) found.push(cmd);
    }
  }
  return found;
}

export function normalizeVerificationCommandKey(command: string): string {
  return command.trim().replace(/\s+/g, ' ').slice(0, 200);
}

export function extractRunCommandsFromDelegateTask(task: string): string[] {
  const commands: string[] = [];
  const lineRe = /(?:^|\n)\s*(?:\d+[.)]\s*)?(?:run\s+)?(?:command\s*[:：]\s*)?(`([^`]+)`|"([^"]+)"|'([^']+)'|((?:npm|npx|pnpm|yarn|node)\s[^\n]+))/gim;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(task)) !== null) {
    const cmd = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (cmd) commands.push(cmd);
  }
  commands.push(...extractBuildLikeCommandsFromText(task));
  return [...new Set(commands)];
}
