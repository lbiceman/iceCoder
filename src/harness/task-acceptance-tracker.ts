import { isLongRunningImplementationGoal } from './resume-goal.js';
import type { CompletionCondition } from './completion-condition.js';
import {
  looksLikeRunnableCommand,
  normalizeAcceptanceCommandKey,
} from './run-command-result.js';
import type { RunCommandResultClassification } from './run-command-result.js';

export type AcceptanceCommandStatus = 'pending' | 'passed' | 'failed';

/** {@link TaskAcceptanceTracker.recordRunCommand} 的 transition 报告。 */
export interface AcceptanceTransition {
  /** 匹配到的验收项标签（人类可读原文）。 */
  command: string;
  previousStatus: AcceptanceCommandStatus;
  newStatus: AcceptanceCommandStatus;
}

export interface AcceptanceCommandEntry {
  /** 规范化后的命令键（用于匹配） */
  key: string;
  /** 展示用原文 */
  label: string;
  status: AcceptanceCommandStatus;
  lastRunAt?: number;
  evidenceRefs?: string[];
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
    this.active = parsed.length > 0 && (
      hasExplicitAcceptanceMarker(goal)
      || (parsed.length >= 2 && isLongRunningImplementationGoal(goal))
    );
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

  getPendingCount(): number {
    return this.getPendingCommands().length;
  }

  getPassedCount(): number {
    return this.commands.filter(c => c.status === 'passed').length;
  }

  /**
   * 记录 run_command 结果。
   * 成功的 `a && b && c` 会把链上每一段对应的验收项都标 passed；
   * 失败只标第一段（`&&` 短路），避免 git diff / 列目录误伤其它项。
   * 返回给上层做 ✓/✗ 提示的那条 transition；未匹配返回 null。
   */
  recordRunCommand(
    rawCommand: string,
    success: boolean,
    evidenceRef?: string,
  ): AcceptanceTransition | null {
    if (!this.isActive() || !rawCommand.trim()) return null;
    const matched = matchAcceptanceEntries(this.commands, rawCommand);
    if (matched.length === 0) return null;
    const targets = success ? matched : matched.slice(0, 1);
    const newStatus: AcceptanceCommandStatus = success ? 'passed' : 'failed';
    let reported: AcceptanceTransition | null = null;
    for (const entry of targets) {
      const previousStatus = entry.status;
      entry.status = newStatus;
      entry.lastRunAt = Date.now();
      if (evidenceRef) {
        entry.evidenceRefs = [...new Set([...(entry.evidenceRefs ?? []), evidenceRef])];
      }
      const transition = { command: entry.label, previousStatus, newStatus };
      if (
        !reported
        || (newStatus === 'passed' && previousStatus !== 'passed')
        || newStatus === 'failed'
      ) {
        reported = transition;
      }
    }
    return reported;
  }

  /**
   * P0-A — 区分「后台启动」与「真实完成」：
   *   - kind:'background_start' / 'background_running' → 状态保持 pending，**不**调用 recordRunCommand
   *   - kind:'background_completed'（exitCode===0）/ 'foreground' & success → mark passed
   *   - kind:'background_failed' / exitCode!==0 → mark failed
   *
   * 调用方应在 run_command 工具结果落到 messages 后调用。
   * 返回 transition 详情（同 {@link recordRunCommand}），未匹配返回 null。
   */
  recordRunCommandToolResult(
    result: RunCommandResultClassification,
    evidenceRef?: string,
  ): AcceptanceTransition | null {
    if (!this.isActive()) return null;
    if (result.kind === 'background_start' || result.kind === 'background_running') return null;
    if (!result.command.trim()) return null;
    const completed = result.kind === 'foreground'
      ? result.foregroundSuccess === true
      : result.kind === 'background_completed'
        && (result.exitCode === undefined || result.exitCode === 0);
    return this.recordRunCommand(result.command, completed, evidenceRef);
  }

  toCompletionConditions(canExecute = true): CompletionCondition[] {
    if (!this.isActive()) return [];
    return this.commands.map(command => ({
      id: `acceptance:${command.key}`,
      label: command.label,
      required: true,
      status: command.status === 'passed'
        ? 'satisfied'
        : !canExecute
          ? 'unverifiable'
          : command.status,
      source: 'user',
      sourceRef: `acceptance:${command.key}`,
      evidenceRefs: [...(command.evidenceRefs ?? [])],
    }));
  }

  buildAcceptancePrompt(): string {
    const unresolved = this.commands.filter(cmd => cmd.status !== 'passed');
    const lines = [
      '[System / Completion Gate] Run the remaining verification once. If it passes, you can finish.',
      '',
      `Progress: ${this.getPassedCount()}/${this.commands.length} passed`,
    ];
    if (unresolved.length > 0) {
      lines.push('', 'Still open:');
      for (const cmd of unresolved) {
        const mark = cmd.status === 'failed' ? '✗' : '○';
        lines.push(`  ${mark} ${cmd.label} (${cmd.status})`);
      }
    }
    lines.push('', 'Re-run those verification commands. Do not substitute unrelated checks.');
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

/** 从 goal 提取用户原文里出现的命令片段（反引号 / 引号 / 箭头链），当作不透明字符串。 */
export function parseAcceptanceCommandsFromGoal(goal: string): Array<{ key: string; label: string }> {
  const found: string[] = [];

  for (const match of goal.matchAll(/`([^`\r\n]+)`/g)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    const parts = candidate.split(/\s*→\s*|\s*->\s*|\s+then\s+/i);
    for (const part of parts) {
      const command = part.trim();
      if (looksLikeRunnableCommand(command)) found.push(command);
    }
  }

  for (const match of goal.matchAll(/['"]([^'"\r\n]+)['"]/g)) {
    const candidate = match[1]?.trim();
    if (candidate && looksLikeRunnableCommand(candidate)) found.push(candidate);
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

function hasExplicitAcceptanceMarker(goal: string): boolean {
  return /验收(?:命令|条件)?|完成条件|必须(?:运行|通过|成功)|全部成功后|done when|acceptance|must (?:pass|succeed|run)|before (?:you )?(?:finish|stop)/i.test(goal);
}

function splitCommandChain(command: string): string[] {
  return command
    .split(/\s*(?:&&|;)\s*/)
    .map(part => part.trim())
    .filter(Boolean);
}

function commandSegmentMatches(segment: string, entryKey: string): boolean {
  if (!segment || !entryKey) return false;
  if (segment === entryKey) return true;
  // 允许额外 flag：`npm test --reporter=verbose` 对上 `npm test`
  return segment.startsWith(`${entryKey} `);
}

function matchAcceptanceEntries(
  entries: AcceptanceCommandEntry[],
  rawCommand: string,
): AcceptanceCommandEntry[] {
  const runKey = normalizeAcceptanceCommandKey(rawCommand);
  if (!runKey) return [];
  const segments = splitCommandChain(runKey);
  const matched: AcceptanceCommandEntry[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const entry = entries.find(item =>
      !seen.has(item.key) && commandSegmentMatches(segment, item.key),
    );
    if (!entry) continue;
    seen.add(entry.key);
    matched.push(entry);
  }
  return matched;
}

export function hasPendingAcceptanceWork(
  acceptance: TaskAcceptanceTracker | undefined,
): boolean {
  return !!acceptance?.isActive() && !acceptance.isComplete();
}
