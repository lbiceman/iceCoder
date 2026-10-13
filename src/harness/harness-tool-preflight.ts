import { realpathSync } from 'node:fs';
import nodePath from 'node:path';

import type { BranchBudgetTracker } from './branch-budget.js';
import { isUnderRoot } from '../shared/path-scope.js';
import {
  canonicalizeMemoryToolPath,
  resolveMemoryRootForPath,
} from '../memory/file-memory/memory-write-pipeline.js';
import { extractRunCommand } from './branch-budget-tool-path.js';
import type { ToolCall } from '../llm/types.js';
import type { CompletionFactsView } from './completion-facts-view.js';
import { workspaceFileExists } from './workspace-path-guard.js';
import {
  checkHostGuardWritePreflight,
} from '../tools/shell-host-guard.js';
import { analyzeShellSandbox } from '../tools/shell-sandbox.js';

export interface ToolPreflightInput {
  toolName: string;
  args: Record<string, unknown>;
  branchBudget?: BranchBudgetTracker;
  completionFacts?: CompletionFactsView;
  buildDiagnosticGateActive?: boolean;
  workspaceRoot?: string;
  lockedWorkspaceRoot?: string;
  /** 同路径 missing-file preflight 拦截次数（由 HarnessRunState 持有）。 */
  missingFileAttempts?: Map<string, number>;
}

export interface ToolPreflightDecision {
  blocked: boolean;
  reason?: 'dist_read' | 'build_diagnostic_gate' | 'delegate_build_blocked' | 'missing_file' | 'missing_file_repeat' | 'host_kill' | 'shell_hard_block' | 'outside_workspace';
  message?: string;
  hostKillLabel?: string;
}

function sandboxBlockPreflightReason(
  sandboxReason: 'hard_block' | 'host_kill' | 'blacklist' | undefined,
): NonNullable<ToolPreflightDecision['reason']> {
  return sandboxReason === 'hard_block' ? 'shell_hard_block' : 'host_kill';
}

const MISSING_FILE_TARGET_TOOLS = new Set(['read_file', 'edit_file', 'patch_file', 'append_file']);
const DIST_ARTIFACT_RE = /^(?:dist|build|out)\//i;

export function isDistArtifactPath(path: string | undefined): boolean {
  if (!path) return false;
  return DIST_ARTIFACT_RE.test(path.replace(/\\/g, '/'));
}

export function isBuildLikeCommand(command: string | undefined): boolean {
  return !!command?.trim();
}

export function isDiagnosticAllowedCommand(_command: string | undefined): boolean {
  return true;
}

function extractTargetPath(args: Record<string, unknown>): string | undefined {
  const raw = args.path ?? args.file_path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function extractShellCollabPreflightCommand(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === 'shell_exec') {
    const command = args.command;
    return typeof command === 'string' && command.trim() ? command.trim() : undefined;
  }
  if (toolName === 'interactive_shell' && args.action === 'start') {
    const command = args.command;
    return typeof command === 'string' && command.trim() ? command.trim() : undefined;
  }
  return undefined;
}

export function buildMissingFileBlockMessage(
  toolName: string,
  filePath: string,
  attempt: number,
): string {
  const repeat = attempt >= 2;
  const header = repeat
    ? `[Harness / Missing File — STOP] ${filePath} still does not exist (attempt ${attempt}).`
    : `[Harness / Missing File] ${filePath} does not exist on disk.`;

  const lines = [
    header,
    repeat
      ? 'Do NOT read_file or patch this path again in this session.'
      : `Blocked ${toolName}: target file is missing.`,
    '- Create it with write_file (full file body). Reference an existing file in the same directory as a template.',
    '- Explore with run_command dir or read_file an existing sibling file.',
    '- Do NOT patch_file / edit_file / append_file / read_file this missing path.',
  ];
  return lines.join('\n');
}

export function checkMissingFilePreflight(input: {
  toolName: string;
  path: string | undefined;
  workspaceRoot?: string;
  lockedWorkspaceRoot?: string;
  missingFileAttempts?: Map<string, number>;
}): ToolPreflightDecision {
  const { toolName, path, workspaceRoot, lockedWorkspaceRoot, missingFileAttempts } = input;
  if (!path || !workspaceRoot || !lockedWorkspaceRoot) {
    return { blocked: false };
  }
  if (!MISSING_FILE_TARGET_TOOLS.has(toolName)) {
    return { blocked: false };
  }
  if (workspaceFileExists(workspaceRoot, path)) {
    return { blocked: false };
  }

  const priorAttempts = missingFileAttempts?.get(path) ?? 0;
  // read_file：首次放行到执行器（mock/真 ENOENT 后再拦）；写类工具直接拦。
  if (toolName === 'read_file' && priorAttempts === 0) {
    return { blocked: false };
  }

  const attempt = priorAttempts + 1;
  missingFileAttempts?.set(path, attempt);

  return {
    blocked: true,
    reason: attempt >= 2 ? 'missing_file_repeat' : 'missing_file',
    message: buildMissingFileBlockMessage(toolName, path, attempt),
  };
}

/** shell 命令的写目标只能启发式提取，不在此拦截。 */
const BOUNDARY_WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'append_file', 'patch_file', 'batch_edit_file', 'fs_operation',
]);

function collectBoundaryWriteTargets(toolName: string, args: Record<string, unknown>): string[] {
  const targets: string[] = [];
  const add = (raw: unknown) => {
    if (typeof raw === 'string' && raw.trim()) targets.push(raw.trim());
  };
  if (toolName === 'fs_operation') {
    const op = String(args.operation ?? '').toLowerCase();
    if (op === 'list') return targets;
    add(args.path ?? args.filePath);
    if (op === 'move' || op === 'copy') add(args.target);
    return targets;
  }
  add(args.path ?? args.file_path);
  return targets;
}

/** 已存在的最近祖先目录的真实路径；用于识别指向工作区外的 symlink / junction。 */
function realpathOfNearestExisting(absPath: string): string {
  let current = absPath;
  while (true) {
    try {
      const real = realpathSync.native(current);
      return current === absPath ? real : nodePath.join(real, nodePath.relative(current, absPath));
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) return absPath;
      current = parent;
    }
  }
}

function isWriteTargetInsideWorkspace(rawPath: string, workspaceRoot: string): boolean {
  const canonical = canonicalizeMemoryToolPath(rawPath, workspaceRoot);
  if (resolveMemoryRootForPath(canonical)) return true;
  if (!isUnderRoot(canonical, workspaceRoot)) return false;
  return isUnderRoot(realpathOfNearestExisting(canonical), realpathOfNearestExisting(nodePath.resolve(workspaceRoot)));
}

/**
 * 锁定工作区后，写类文件工具的目标必须在工作区内（长期记忆目录除外）。
 * referenceReads 只允许读，因此同样被拦。未锁定工作区时不限制。
 */
export function checkWorkspaceWriteBoundary(input: {
  toolName: string;
  args: Record<string, unknown>;
  workspaceRoot?: string;
  lockedWorkspaceRoot?: string;
}): ToolPreflightDecision {
  const { toolName, args, workspaceRoot, lockedWorkspaceRoot } = input;
  if (!workspaceRoot || !lockedWorkspaceRoot || !BOUNDARY_WRITE_TOOLS.has(toolName)) {
    return { blocked: false };
  }
  for (const target of collectBoundaryWriteTargets(toolName, args)) {
    if (isWriteTargetInsideWorkspace(target, workspaceRoot)) continue;
    return {
      blocked: true,
      reason: 'outside_workspace',
      message: [
        `[Harness / Workspace Boundary] ${toolName} blocked: ${target} is outside the locked workspace.`,
        `Workspace: ${workspaceRoot}`,
        'Only write inside the workspace. If the user really wants files elsewhere, ask them to switch the workspace first.',
      ].join('\n'),
    };
  }
  return { blocked: false };
}

export function checkToolPreflight(input: ToolPreflightInput): ToolPreflightDecision {
  const path = extractTargetPath(input.args);

  const boundary = checkWorkspaceWriteBoundary(input);
  if (boundary.blocked) return boundary;

  const missing = checkMissingFilePreflight({
    toolName: input.toolName,
    path,
    workspaceRoot: input.workspaceRoot,
    lockedWorkspaceRoot: input.lockedWorkspaceRoot,
    missingFileAttempts: input.missingFileAttempts,
  });
  if (missing.blocked) return missing;

  if (input.toolName === 'read_file' && isDistArtifactPath(path)) {
    const verification = input.completionFacts?.verificationSignal();
    if (verification?.status === 'failed' || verification?.status === 'pending') {
      return {
        blocked: true,
        reason: 'dist_read',
        message: [
          '[Harness / Preflight] read_file blocked: build artifacts are unavailable until verification passes.',
          `Path: ${path}`,
          'Path is a build artifact. Read sources in the workspace instead of dist/build/out.',
        ].join('\n'),
      };
    }
  }

  if (input.toolName === 'run_command' && input.buildDiagnosticGateActive) {
    const command = extractRunCommand(input.args);
    if (command && input.branchBudget?.wouldBlockCommandRetry(command)) {
      return {
        blocked: true,
        reason: 'build_diagnostic_gate',
        message: [
          '[Harness / Diagnostic Gate] the failed command is paused until you diagnose the failure.',
          `Blocked command: ${command}`,
          'Read this round\'s output, fix the cause, then re-run the project\'s own verification command.',
          'Do not rerun the same failed command until the implementation changes.',
        ].join('\n'),
      };
    }
  }

  if (input.toolName === 'run_command') {
    const command = extractRunCommand(input.args);
    if (command) {
      const sandbox = analyzeShellSandbox(command, {
        workDir: input.workspaceRoot,
        includeBlacklist: false,
      });
      if (sandbox.blocked) {
        return {
          blocked: true,
          reason: sandboxBlockPreflightReason(sandbox.reason),
          hostKillLabel: sandbox.matchLabel,
          message: sandbox.message ?? '[Sandbox / Blocked]',
        };
      }
    }
  }

  if (input.toolName === 'shell_exec' || input.toolName === 'interactive_shell') {
    const command = extractShellCollabPreflightCommand(input.toolName, input.args);
    if (command) {
      const sandbox = analyzeShellSandbox(command, {
        workDir: input.workspaceRoot,
        includeBlacklist: false,
      });
      if (sandbox.blocked) {
        return {
          blocked: true,
          reason: sandboxBlockPreflightReason(sandbox.reason),
          hostKillLabel: sandbox.matchLabel,
          message: sandbox.message ?? '[Sandbox / Blocked]',
        };
      }
    }
  }

  const hostWrite = checkHostGuardWritePreflight(input.toolName, input.args);
  if (hostWrite.blocked) {
    return {
      blocked: true,
      reason: 'host_kill',
      hostKillLabel: hostWrite.matchLabel,
      message: hostWrite.message ?? '[HostGuard / Blocked]',
    };
  }

  return { blocked: false };
}

export function shouldActivateBuildDiagnosticGate(args: {
  branchBudget?: BranchBudgetTracker;
  executionFailedSignatures: string[];
  policyBlockedSignatures: string[];
  toolCalls: ToolCall[];
  signatureOf: (tc: ToolCall) => string;
}): boolean {
  if (!args.branchBudget) return false;

  for (const tc of args.toolCalls) {
    if (tc.name !== 'run_command') continue;
    const command = extractRunCommand(tc.arguments);
    if (!isBuildLikeCommand(command)) continue;
    if (!args.branchBudget.wouldBlockCommandRetry(command)) continue;
    const sig = args.signatureOf(tc);
    if (args.executionFailedSignatures.includes(sig) || args.policyBlockedSignatures.includes(sig)) {
      return true;
    }
  }
  return false;
}

export function shouldClearBuildDiagnosticGate(args: {
  toolCalls: ToolCall[];
  failedSignatures: string[];
  signatureOf: (tc: ToolCall) => string;
}): boolean {
  const writeTools = new Set(['write_file', 'edit_file', 'append_file', 'batch_edit_file', 'patch_file']);
  for (const tc of args.toolCalls) {
    if (!writeTools.has(tc.name)) continue;
    if (args.failedSignatures.includes(args.signatureOf(tc))) continue;
    const path = typeof tc.arguments.path === 'string'
      ? tc.arguments.path
      : (typeof tc.arguments.file_path === 'string' ? tc.arguments.file_path : undefined);
    if (path) return true;
  }
  return false;
}

export function buildDiagnosticGateMessage(): string {
  return [
    '[System / Build Diagnostic Gate]',
    'A verification command is blocked by BranchBudget after repeated failures.',
    'Switch to diagnosis: read this round\'s failing output, fix the cause, then re-run the project\'s own verification command.',
    'Do not rerun the same failed command until the implementation changes.',
  ].join('\n');
}
