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
  onWarning?: (warning: VerificationPlanWarning) => void;
}

export interface VerificationPlanWarning {
  kind: 'malformed' | 'read_error' | 'invalid_command';
  source: 'user_goal' | 'workspace_config' | 'package_manifest' | 'lockfile';
  path: string;
  code?: string;
  message: string;
}

interface LocatedCommand {
  index: number;
  command: string;
}

const STRICT_MARKER =
  /完成条件\s*[：:]\s*必须(?:运行|通过)|验收命令\s*[：:]|completion\s+condition\s*:\s*must\s+(?:run|pass)|must\s+(?:run|pass)/gi;
const CODE_SPAN = /`([^`]*)`/g;
const POSTFIX_BEFORE_FINISH = /`([^`]*)`\s+before\s+(?:you\s+)?finish/gi;

interface ParsedVerificationCommands {
  commands: string[];
  explicitCandidateCount: number;
}

interface WorkspaceVerificationCommands {
  commands: string[];
  disabled: boolean;
}

/**
 * 只提取受明确 marker 直接支配的反引号命令。
 * marker 后可跟一个由常见分隔符连接的命令列表；普通反引号不会被全局扫描进计划。
 */
export function parseVerificationCommandsFromGoal(
  goal: string,
  onWarning?: (warning: VerificationPlanWarning) => void,
): string[] {
  return parseVerificationCommands(goal, onWarning).commands;
}

function parseVerificationCommands(
  goal: string,
  onWarning?: (warning: VerificationPlanWarning) => void,
): ParsedVerificationCommands {
  const codeSpans = Array.from(goal.matchAll(CODE_SPAN), match => ({
    index: match.index,
    end: match.index + match[0].length,
    command: match[1] ?? '',
  }));
  const located: LocatedCommand[] = [];

  for (const marker of goal.matchAll(STRICT_MARKER)) {
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
  }

  for (const match of goal.matchAll(POSTFIX_BEFORE_FINISH)) {
    located.push({ index: match.index, command: match[1] ?? '' });
  }

  located.sort((left, right) => left.index - right.index);
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const item of located) {
    const command = normalizeVerificationCommand(item.command);
    if (!command) {
      emitWarning(onWarning, {
        kind: 'invalid_command',
        source: 'user_goal',
        path: '<goal>',
        message: 'explicit verification command is empty, too long, or contains newline/NUL',
      });
      continue;
    }
    if (seen.has(command)) continue;
    seen.add(command);
    commands.push(command);
  }
  return { commands, explicitCandidateCount: located.length };
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
  const parsedUserCommands = parseVerificationCommands(options.goal, options.onWarning);
  const userPlan = buildVerificationPlan({
    source: 'user',
    commands: parsedUserCommands.commands,
    workspaceRoot: options.workspaceRoot,
  });
  if (userPlan) return userPlan;
  if (parsedUserCommands.explicitCandidateCount > 0) return null;

  const projectCommands = await readWorkspaceVerificationCommands(
    options.workspaceRoot,
    options.onWarning,
  );
  if (projectCommands.disabled) return null;
  const projectPlan = buildVerificationPlan({
    source: 'project',
    commands: projectCommands.commands,
    workspaceRoot: options.workspaceRoot,
  });
  if (projectPlan) return projectPlan;

  const runtimeCommand = await resolveRuntimeDefaultCommand(
    options.workspaceRoot,
    options.onWarning,
  );
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

async function readWorkspaceVerificationCommands(
  workspaceRoot: string,
  onWarning?: (warning: VerificationPlanWarning) => void,
): Promise<WorkspaceVerificationCommands> {
  if (!workspaceRoot.trim()) return { commands: [], disabled: false };
  for (const name of WORKSPACE_ICECODER_CONFIG_NAMES) {
    const configPath = path.join(workspaceRoot, name);
    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        emitWarning(onWarning, warningFromError(
          'read_error',
          'workspace_config',
          configPath,
          error,
        ));
      }
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        emitMalformedWarning(onWarning, 'workspace_config', configPath, 'expected JSON object');
        continue;
      }
      if (parsed.verificationCommands === undefined) continue;
      if (!Array.isArray(parsed.verificationCommands)) {
        emitMalformedWarning(
          onWarning,
          'workspace_config',
          configPath,
          'verificationCommands must be an array',
        );
        continue;
      }
      if (parsed.verificationCommands.length === 0) {
        return { commands: [], disabled: true };
      }
      const commands = parsed.verificationCommands.filter(
        (value): value is string => typeof value === 'string',
      );
      if (commands.length !== parsed.verificationCommands.length) {
        emitMalformedWarning(
          onWarning,
          'workspace_config',
          configPath,
          'verificationCommands contains non-string entries',
        );
      }
      return { commands, disabled: false };
    } catch (error) {
      emitWarning(onWarning, warningFromError(
        'malformed',
        'workspace_config',
        configPath,
        error,
      ));
    }
  }
  return { commands: [], disabled: false };
}

async function resolveRuntimeDefaultCommand(
  workspaceRoot: string,
  onWarning?: (warning: VerificationPlanWarning) => void,
): Promise<string | null> {
  if (!workspaceRoot.trim()) return null;
  const manifestPath = path.join(workspaceRoot, 'package.json');
  let rawManifest: string;
  try {
    rawManifest = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      emitWarning(onWarning, warningFromError(
        'read_error',
        'package_manifest',
        manifestPath,
        error,
      ));
    }
    return null;
  }

  try {
    const packageJson = JSON.parse(rawManifest) as { scripts?: { test?: unknown } };
    if (
      !packageJson.scripts
      || typeof packageJson.scripts.test !== 'string'
      || !packageJson.scripts.test.trim()
    ) {
      return null;
    }
  } catch (error) {
    emitWarning(onWarning, warningFromError(
      'malformed',
      'package_manifest',
      manifestPath,
      error,
    ));
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
    const lockfilePath = path.join(workspaceRoot, lockfile);
    try {
      await fs.access(lockfilePath);
      return command;
    } catch (error) {
      if (!isMissingFileError(error)) {
        emitWarning(onWarning, warningFromError(
          'read_error',
          'lockfile',
          lockfilePath,
          error,
        ));
      }
    }
  }
  return 'npm test';
}

function emitMalformedWarning(
  onWarning: ((warning: VerificationPlanWarning) => void) | undefined,
  source: VerificationPlanWarning['source'],
  filePath: string,
  message: string,
): void {
  emitWarning(onWarning, { kind: 'malformed', source, path: filePath, message });
}

function emitWarning(
  onWarning: ((warning: VerificationPlanWarning) => void) | undefined,
  warning: VerificationPlanWarning,
): void {
  try {
    onWarning?.(warning);
  } catch {
    // 可观测回调不得改变解析器的 fallback 语义。
  }
}

function warningFromError(
  kind: VerificationPlanWarning['kind'],
  source: VerificationPlanWarning['source'],
  filePath: string,
  error: unknown,
): VerificationPlanWarning {
  const code = errorCode(error);
  return {
    kind,
    source,
    path: filePath,
    ...(code ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
