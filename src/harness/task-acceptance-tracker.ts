import { isLongRunningImplementationGoal } from './resume-goal.js';

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

  getPendingCount(): number {
    return this.getPendingCommands().length;
  }

  getPassedCount(): number {
    return this.commands.filter(c => c.status === 'passed').length;
  }

  /**
   * 记录 run_command 结果；匹配第一条语义相同的验收项。
   * 返回 transition 详情（命令、前后状态），方便上层注入「刚刚 ✓ / ✗」的反馈消息。
   * 返回 null 表示未匹配到任何验收项。
   */
  recordRunCommand(rawCommand: string, success: boolean): AcceptanceTransition | null {
    if (!this.isActive() || !rawCommand.trim()) return null;
    const entry = matchAcceptanceEntry(this.commands, rawCommand);
    if (!entry) return null;
    const previousStatus = entry.status;
    const newStatus: AcceptanceCommandStatus = success ? 'passed' : 'failed';
    entry.status = newStatus;
    entry.lastRunAt = Date.now();
    return { command: entry.label, previousStatus, newStatus };
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
  recordRunCommandToolResult(result: RunCommandResultClassification): AcceptanceTransition | null {
    if (!this.isActive()) return null;
    if (result.kind === 'background_start' || result.kind === 'background_running') return null;
    if (!result.command.trim()) return null;
    const completed = result.kind === 'foreground'
      ? result.foregroundSuccess === true
      : result.kind === 'background_completed'
        && (result.exitCode === undefined || result.exitCode === 0);
    return this.recordRunCommand(result.command, completed);
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

/**
 * 剥离 Windows / POSIX 常见的 `cd ... && <real-cmd>` 前缀，仅保留真实命令体。
 * 例如：
 *   `cd /d E:\\foo && npm run build` → `npm run build`
 *   `cd ./pkg && npm test`           → `npm test`
 * 仅当 `&&` 后还存在非空命令时才剥离，避免把 `cd somewhere` 单独剥成空串。
 */
export function stripLeadingCdPrefix(command: string): string {
  const re = /^cd\s+(?:\/d\s+)?(?:"[^"]+"|'[^']+'|[^\s&|;]+)\s*&&\s*(.+)$/i;
  const m = command.trim().match(re);
  return m && m[1].trim() ? m[1].trim() : command.trim();
}

/**
 * Acceptance 命令归一化：用于 goal 解析键与 run_command 实际命令的稳定匹配。
 *
 * 处理：
 * - 剥离 `cd ... && ` 前缀（Windows `cd /d` / Unix 通用）
 * - 去掉常见尾缀 `2>&1`、`| tail …`、`| head …`、`| less` 等
 * - 折叠空白，转小写
 * - `npx playwright test` ↔ `npm run test:e2e` 等价归一化
 * - `npm run test` → `npm test`（同义脚本）
 */
export function normalizeAcceptanceCommandKey(command: string): string {
  let key = stripLeadingCdPrefix(command);

  key = key
    .replace(/\s+/g, ' ')
    .replace(/\s2>&1\s*$/i, '')
    .replace(/\s\|\s*(head|tail|less|more|grep)\b[^|]*$/i, '')
    .replace(/\s>\s*\S+(?:\s+2>&1)?\s*$/i, '')
    .trim()
    .toLowerCase();

  // 等价归一化：playwright/cypress e2e 视作 `npm run test:e2e`
  if (/\bnpx\s+playwright\s+test\b/.test(key) || /\bplaywright\s+test\b/.test(key)) {
    return 'npm run test:e2e';
  }
  if (/\bnpx\s+cypress\s+run\b/.test(key)) {
    return 'npm run test:e2e';
  }
  // `npm run test` ↔ `npm test`
  if (/^npm\s+run\s+test(?:\s|$)/.test(key) && !/\btest:/.test(key)) {
    key = key.replace(/^npm\s+run\s+test\b/, 'npm test');
  }
  // `npx vitest run` / `npx vitest` 视作 `npm test`（针对 vitest 单测仓库）
  if (/^npx\s+vitest(?:\s+run)?\b/.test(key)) {
    return 'npm test';
  }

  return key;
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

/**
 * P0-A — `run_command` 工具结果分类。
 *
 * 历史问题：shell-tool 后台分支返回 `success: true` 表示「启动成功」，
 * acceptance gate 直接据此把命令标 passed，但**进程往往还在跑**或已 exit ≠ 0。
 *
 * 本分类器解析 raw output 的 JSON 元数据（`mode` / `status` / `exitCode`），
 * 让 acceptance / verification-buffer / branch-budget 等下游按真实结果判定。
 */
export type RunCommandResultClassification =
  | { kind: 'foreground'; command: string; foregroundSuccess: boolean; exitCode?: number }
  | { kind: 'background_start'; command: string }
  | { kind: 'background_running'; command: string }
  | { kind: 'background_completed'; command: string; exitCode?: number }
  | { kind: 'background_failed'; command: string; exitCode?: number; statusLabel?: string };

export function classifyRunCommandResult(
  args: Record<string, unknown> | undefined | null,
  rawOutput: string,
  toolSuccess: boolean,
): RunCommandResultClassification | null {
  const a = args ?? {};
  const action = typeof a.action === 'string' ? a.action.trim() : '';
  const argCommand = typeof a.command === 'string'
    ? a.command
    : typeof a.cmd === 'string'
      ? a.cmd
      : '';

  if (action === 'check' || action === 'list' || action === 'stop') {
    const parsed = safeParseJson(rawOutput);
    if (!parsed) return null;
    const label = typeof parsed.label === 'string' ? parsed.label : '';
    // P0: 优先用 check 响应里的 `command`（shell-tool 已暴露真实命令）；
    // 旧 checkpoint / 早期响应可能只有 label，回退到 label。
    const cmdFromResponse = typeof parsed.command === 'string' && parsed.command.trim()
      ? parsed.command.trim()
      : label;
    const status = typeof parsed.status === 'string' ? parsed.status : '';
    const exitCode = typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined;
    if (!cmdFromResponse) return null;
    if (status === 'completed') {
      const isExitNonZero = exitCode !== undefined && exitCode !== 0;
      return isExitNonZero
        ? { kind: 'background_failed', command: cmdFromResponse, exitCode, statusLabel: 'completed_nonzero' }
        : { kind: 'background_completed', command: cmdFromResponse, exitCode };
    }
    if (status === 'failed' || status === 'timeout' || status === 'killed') {
      return { kind: 'background_failed', command: cmdFromResponse, exitCode, statusLabel: status };
    }
    if (status === 'running') {
      return { kind: 'background_running', command: cmdFromResponse };
    }
    return null;
  }

  if (!argCommand.trim()) return null;
  if (toolSuccess) {
    const parsed = safeParseJson(rawOutput);
    if (parsed) {
      const mode = typeof parsed.mode === 'string' ? parsed.mode : '';
      if (mode === 'background' || mode === 'escalated') {
        return { kind: 'background_start', command: argCommand };
      }
    }
  }
  return { kind: 'foreground', command: argCommand, foregroundSuccess: toolSuccess };
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
