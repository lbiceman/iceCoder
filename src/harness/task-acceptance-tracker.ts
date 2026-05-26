import { isLongRunningImplementationGoal } from './resume-goal.js';

export type AcceptanceCommandStatus = 'pending' | 'passed' | 'failed';

export interface AcceptanceCommandEntry {
  /** 规范化后的命令键（用于匹配） */
  key: string;
  /** 展示用原文 */
  label: string;
  status: AcceptanceCommandStatus;
  lastRunAt?: number;
}

export interface AcceptanceGateSnapshot {
  active: boolean;
  commands: AcceptanceCommandEntry[];
}

/** 从 goal 解析的多步验收命令（长跑 benchmark / 显式验收句式）。 */
export class TaskAcceptanceTracker {
  private active: boolean;
  private commands: AcceptanceCommandEntry[];

  constructor(goal: string, presetCommands?: string[]) {
    const parsed = presetCommands?.length
      ? presetCommands.map(c => ({ key: normalizeAcceptanceCommandKey(c), label: c.trim() }))
      : parseAcceptanceCommandsFromGoal(goal);
    this.active = parsed.length >= 2 && isLongRunningImplementationGoal(goal);
    this.commands = parsed.map(({ key, label }) => ({
      key,
      label,
      status: 'pending' as AcceptanceCommandStatus,
    }));
  }

  /** 从 checkpoint 恢复（跳过 goal 解析）。 */
  static fromSnapshot(snapshot: AcceptanceGateSnapshot): TaskAcceptanceTracker {
    const tracker = new TaskAcceptanceTracker('restored-acceptance-gate');
    tracker.active = snapshot.active;
    tracker.commands = snapshot.commands.map(c => ({ ...c }));
    return tracker;
  }

  isActive(): boolean {
    return this.active && this.commands.length > 0;
  }

  isComplete(): boolean {
    if (!this.isActive()) return true;
    return this.commands.every(c => c.status === 'passed');
  }

  hasFailure(): boolean {
    return this.commands.some(c => c.status === 'failed');
  }

  getPendingCommands(): AcceptanceCommandEntry[] {
    return this.commands.filter(c => c.status === 'pending');
  }

  getPassedCount(): number {
    return this.commands.filter(c => c.status === 'passed').length;
  }

  /** 记录 run_command 结果；匹配第一条语义相同的验收项。 */
  recordRunCommand(rawCommand: string, success: boolean): boolean {
    if (!this.isActive() || !rawCommand.trim()) return false;
    const entry = matchAcceptanceEntry(this.commands, rawCommand);
    if (!entry) return false;
    entry.status = success ? 'passed' : 'failed';
    entry.lastRunAt = Date.now();
    return true;
  }

  buildAcceptancePrompt(): string {
    const lines = [
      '[System / Acceptance Gate] Task is NOT complete. Required verification commands must all exit 0 before you may stop.',
      '',
      `Progress: ${this.getPassedCount()}/${this.commands.length} passed`,
      '',
      'Required commands:',
    ];
    for (const cmd of this.commands) {
      const mark = cmd.status === 'passed' ? '✓' : cmd.status === 'failed' ? '✗' : '○';
      lines.push(`  ${mark} ${cmd.label} (${cmd.status})`);
    }
    const next = this.getPendingCommands()[0] ?? this.commands.find(c => c.status === 'failed');
    if (next) {
      lines.push('', `Next: run \`${next.label}\`, fix failures, then continue remaining commands.`);
    }
    lines.push('', 'Do not output final delivery bullets or stop calling tools until all commands pass.');
    return lines.join('\n');
  }

  snapshot(): AcceptanceGateSnapshot {
    return {
      active: this.active,
      commands: this.commands.map(c => ({ ...c })),
    };
  }

  restore(snapshot: AcceptanceGateSnapshot | undefined): void {
    if (!snapshot?.commands?.length) return;
    this.active = snapshot.active;
    this.commands = snapshot.commands.map(c => ({ ...c }));
  }
}

/** 从 goal 提取 `npm ci → npm test → ...` 或枚举式验收命令。 */
export function parseAcceptanceCommandsFromGoal(goal: string): Array<{ key: string; label: string }> {
  const found: string[] = [];

  if (/npm ci[^→\n]*→[^→\n]*npm test[^→\n]*→[^→\n]*npm run build[^→\n]*→[^→\n]*npm run test:e2e/is.test(goal)) {
    found.push('npm ci', 'npm test', 'npm run build', 'npm run test:e2e');
  }

  const arrowBlock = goal.match(
    /[`'"]?(npm ci\s*→\s*npm test\s*→\s*npm run build\s*→\s*npm run test:e2e)[`'"]?/i,
  );
  if (arrowBlock && found.length === 0) {
    found.push('npm ci', 'npm test', 'npm run build', 'npm run test:e2e');
  }

  if (found.length === 0) {
    const fourCmd = goal.match(
      /(?:全部|all).*?(npm ci)[^\n]*?(npm test)[^\n]*?(npm run build)[^\n]*?(npm run test:e2e)/is,
    );
    if (fourCmd) {
      found.push('npm ci', 'npm test', 'npm run build', 'npm run test:e2e');
    }
  }

  if (found.length === 0) {
    const listed = goal.match(
      /验收命令[^`\n]*[`'"]?(npm ci[^`'"]+)['`"]?/i,
    );
    if (listed) {
      const segment = listed[1];
      const parts = segment.split(/\s*→\s*|\s*->\s*|\s*,\s*|\s+then\s+/i);
      for (const p of parts) {
        const cmd = p.trim().replace(/\s*（[^）]*）\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '');
        if (/^(npm|pnpm|yarn|npx)\s/i.test(cmd)) found.push(cmd);
      }
    }
  }

  const unique: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const label = raw.trim();
    const key = normalizeAcceptanceCommandKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ key, label });
  }
  return unique;
}

export function normalizeAcceptanceCommandKey(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s2>&1\s*$/i, '')
    .replace(/\s\|\s*head\s+-[^\s]+/i, '')
    .toLowerCase();
}

function matchAcceptanceEntry(
  entries: AcceptanceCommandEntry[],
  rawCommand: string,
): AcceptanceCommandEntry | undefined {
  const runKey = normalizeAcceptanceCommandKey(rawCommand);
  if (!runKey) return undefined;

  for (const entry of entries) {
    if (runKey === entry.key) return entry;
  }

  for (const entry of entries) {
    if (runKey.includes(entry.key) || entry.key.includes(runKey)) return entry;
  }

  // `npm test 2>&1` matches `npm test`; chained commands match if all parts present
  for (const entry of entries) {
    const entryBase = entry.key.split('&&')[0]?.trim() ?? entry.key;
    if (runKey.startsWith(entryBase) || runKey.includes(` ${entryBase}`)) return entry;
  }

  return undefined;
}

export function hasPendingAcceptanceWork(
  acceptance: TaskAcceptanceTracker | undefined,
): boolean {
  return !!acceptance?.isActive() && !acceptance.isComplete();
}
