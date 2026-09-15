import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { WORKSPACE_ICECODER_CONFIG_NAMES } from './verification-exempt-config.js';

export type VerificationPlanSource = 'user' | 'project' | 'runtime_default';

export interface VerificationPlanCommand {
  command: string;
  required: boolean;
  timeoutMs: number;
}

export interface VerificationPlan {
  id: string;
  source: VerificationPlanSource;
  commands: VerificationPlanCommand[];
  fingerprint: string;
}

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000;
export const MAX_VERIFICATION_COMMAND_LENGTH = 500;

type VerificationCommandInput = string | VerificationPlanCommand;

export interface BuildVerificationPlanOptions {
  source: VerificationPlanSource;
  commands: readonly VerificationCommandInput[];
  workspaceRoot: string;
}

export interface ResolveVerificationPlanOptions {
  goal: string;
  workspaceRoot: string;
}

interface LocatedCommand {
  index: number;
  command: string;
}

const STRICT_MARKER =
  /完成条件\s*[：:]?\s*必须(?:运行|通过)?|验收命令|完成条件|必须(?:运行|通过)|completion\s+condition|acceptance|must\s+(?:run|pass)|before\s+(?:you\s+)?finish/gi;
const CODE_SPAN = /`([^`]*)`/g;

/**
 * 只提取受明确 marker 直接支配的反引号命令。
 * marker 后可跟一个由常见分隔符连接的命令列表；普通反引号不会被全局扫描进计划。
 */
export function parseVerificationCommandsFromGoal(goal: string): string[] {
  const codeSpans = Array.from(goal.matchAll(CODE_SPAN), match => ({
    index: match.index,
    end: match.index + match[0].length,
    command: match[1] ?? '',
  }));
  const located: LocatedCommand[] = [];

  for (const marker of goal.matchAll(STRICT_MARKER)) {
    const markerStart = marker.index;
    const markerEnd = marker.index + marker[0].length;
    const following = codeSpans.filter(span => span.index >= markerEnd);
    let cursor = markerEnd;
    let acceptedAny = false;

    for (const span of following) {
      const separator = goal.slice(cursor, span.index);
      if (hasSentenceBoundary(separator)) break;
      if (
        acceptedAny
          ? !isCommandListSeparator(separator)
          : !isMarkerCommandSeparator(separator)
      ) {
        break;
      }
      located.push({ index: span.index, command: span.command });
      acceptedAny = true;
      cursor = span.end;
    }

    const preceding = [...codeSpans].reverse().find(span => span.end <= markerStart);
    if (preceding) {
      const separator = goal.slice(preceding.end, markerStart);
      if (!hasSentenceBoundary(separator) && isReverseMarkerSeparator(separator)) {
        located.push({ index: preceding.index, command: preceding.command });
      }
    }
  }

  located.sort((left, right) => left.index - right.index);
  return normalizeVerificationCommands(located.map(item => item.command));
}

export function buildVerificationPlan(
  options: BuildVerificationPlanOptions,
): VerificationPlan | null {
  const commands = normalizePlanCommands(options.commands);
  if (commands.length === 0) return null;

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      source: options.source,
      cwd: normalizeWorkspaceRoot(options.workspaceRoot),
      commands: commands.map(command => ({
        command: normalizeCommandForFingerprint(command.command),
        required: command.required,
        timeoutMs: command.timeoutMs,
      })),
    }))
    .digest('hex');

  return {
    id: `verification:${fingerprint.slice(0, 16)}`,
    source: options.source,
    commands,
    fingerprint,
  };
}

export async function resolveVerificationPlan(
  options: ResolveVerificationPlanOptions,
): Promise<VerificationPlan | null> {
  const userCommands = parseVerificationCommandsFromGoal(options.goal);
  const userPlan = buildVerificationPlan({
    source: 'user',
    commands: userCommands,
    workspaceRoot: options.workspaceRoot,
  });
  if (userPlan) return userPlan;

  const projectCommands = await readWorkspaceVerificationCommands(options.workspaceRoot);
  const projectPlan = buildVerificationPlan({
    source: 'project',
    commands: projectCommands,
    workspaceRoot: options.workspaceRoot,
  });
  if (projectPlan) return projectPlan;

  const runtimeCommand = await resolveRuntimeDefaultCommand(options.workspaceRoot);
  return buildVerificationPlan({
    source: 'runtime_default',
    commands: runtimeCommand ? [runtimeCommand] : [],
    workspaceRoot: options.workspaceRoot,
  });
}

function normalizePlanCommands(
  inputs: readonly VerificationCommandInput[],
): VerificationPlanCommand[] {
  const commands: VerificationPlanCommand[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const rawCommand = typeof input === 'string' ? input : input.command;
    const command = normalizeVerificationCommand(rawCommand);
    if (!command || seen.has(command)) continue;
    seen.add(command);
    commands.push({
      command,
      required: typeof input === 'string' ? true : input.required,
      timeoutMs: typeof input === 'string'
        ? DEFAULT_VERIFICATION_TIMEOUT_MS
        : normalizeTimeout(input.timeoutMs),
    });
  }
  return commands;
}

function normalizeVerificationCommands(commands: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of commands) {
    const command = normalizeVerificationCommand(raw);
    if (!command || seen.has(command)) continue;
    seen.add(command);
    normalized.push(command);
  }
  return normalized;
}

function normalizeVerificationCommand(command: unknown): string | null {
  if (typeof command !== 'string') return null;
  const normalized = command.trim();
  if (
    !normalized
    || normalized.length > MAX_VERIFICATION_COMMAND_LENGTH
    || /[\r\n\u0000]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeCommandForFingerprint(command: string): string {
  return command.trim();
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot || '.').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_VERIFICATION_TIMEOUT_MS;
  }
  return Math.floor(timeoutMs);
}

function hasSentenceBoundary(separator: string): boolean {
  return /[。.!?！？\r\n]/.test(separator);
}

function isMarkerCommandSeparator(separator: string): boolean {
  return /^[\s:：\-—]*(?:commands?\s*(?:are\s*)?)?[:：\-—]*$/i.test(separator);
}

function isCommandListSeparator(separator: string): boolean {
  return /^[\s,，、;；/|→]*(?:(?:and|then|以及|和)\s*)?$/i.test(separator);
}

function isReverseMarkerSeparator(separator: string): boolean {
  return /^[\s,:：，、;；\-—]*$/i.test(separator);
}

async function readWorkspaceVerificationCommands(workspaceRoot: string): Promise<string[]> {
  if (!workspaceRoot.trim()) return [];
  for (const name of WORKSPACE_ICECODER_CONFIG_NAMES) {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, name), 'utf8');
      const parsed = JSON.parse(raw) as { verificationCommands?: unknown };
      if (!Array.isArray(parsed.verificationCommands)) continue;
      return parsed.verificationCommands.filter(
        (value): value is string => typeof value === 'string',
      );
    } catch {
      continue;
    }
  }
  return [];
}

async function resolveRuntimeDefaultCommand(workspaceRoot: string): Promise<string | null> {
  if (!workspaceRoot.trim()) return null;
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf8'),
    ) as { scripts?: { test?: unknown } };
    if (
      !packageJson.scripts
      || typeof packageJson.scripts.test !== 'string'
      || !packageJson.scripts.test.trim()
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const lockfileCommands = [
    ['pnpm-lock.yaml', 'pnpm test'],
    ['yarn.lock', 'yarn test'],
    ['bun.lock', 'bun test'],
    ['bun.lockb', 'bun test'],
    ['package-lock.json', 'npm test'],
  ] as const;

  for (const [lockfile, command] of lockfileCommands) {
    try {
      await fs.access(path.join(workspaceRoot, lockfile));
      return command;
    } catch {
      // 缺失或不可读的锁文件只影响包管理器选择。
    }
  }
  return 'npm test';
}
