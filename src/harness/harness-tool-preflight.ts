import type { BranchBudgetTracker } from './branch-budget.js';
import { extractRunCommand } from './branch-budget-tool-path.js';
import type { ToolCall } from '../llm/types.js';
import type { TaskState } from './task-state.js';import { isBuildVerificationCommand, isHarnessVerificationCommand } from './verification-digest.js';
import { extractRunCommandsFromDelegateTask } from './verification-output-buffer.js';

export interface ToolPreflightInput {
  toolName: string;
  args: Record<string, unknown>;
  branchBudget?: BranchBudgetTracker;
  taskState?: TaskState;
  buildDiagnosticGateActive?: boolean;
}

export interface ToolPreflightDecision {
  blocked: boolean;
  reason?: 'dist_read' | 'build_diagnostic_gate' | 'delegate_build_blocked';
  message?: string;
}
const DIST_ARTIFACT_RE = /^(?:dist|build|out)\//i;
const SOURCE_FILE_RE = /^src\/.*\.(ts|tsx|js|jsx)$/i;

export function isDistArtifactPath(path: string | undefined): boolean {
  if (!path) return false;
  return DIST_ARTIFACT_RE.test(path.replace(/\\/g, '/'));
}

export function isBuildLikeCommand(command: string | undefined): boolean {
  if (!command) return false;
  return isBuildVerificationCommand(command)
    && !/\btsc\b.*--no-emit|\btsc\b.*--noEmit/i.test(command);
}

export function isDiagnosticAllowedCommand(command: string | undefined): boolean {
  if (!command) return false;
  const c = command.toLowerCase();
  return /\bnpx\s+tsc\b/.test(c)
    || /\btsc\s+--no-emit\b/.test(c)
    || /\btsc\s+--noEmit\b/.test(c);
}

export function checkToolPreflight(input: ToolPreflightInput): ToolPreflightDecision {
  const path = typeof input.args.path === 'string'
    ? input.args.path
    : (typeof input.args.file_path === 'string' ? input.args.file_path : undefined);

  if (input.toolName === 'read_file' && isDistArtifactPath(path)) {
    const verification = input.taskState?.snapshot().verificationStatus;
    if (verification === 'failed' || verification === 'required') {
      return {
        blocked: true,
        reason: 'dist_read',
        message: [
          '[Harness / Preflight] read_file blocked: build artifacts are unavailable until verification passes.',
          `Path: ${path}`,
          'Run npx tsc --noEmit or npm run build first; read source under src/ instead of dist/.',
        ].join('\n'),
      };
    }
  }

  if (input.toolName === 'run_command' && input.buildDiagnosticGateActive) {
    const command = extractRunCommand(input.args);
    if (isBuildLikeCommand(command) && !isDiagnosticAllowedCommand(command)) {
      return {
        blocked: true,
        reason: 'build_diagnostic_gate',
        message: [
          '[Harness / Diagnostic Gate] build commands are paused until you diagnose the failure.',
          `Blocked command: ${command}`,
          'Required next steps:',
          '1. read_file the TypeScript sources referenced in the last build/tsc error',
          '2. run npx tsc --noEmit 2>&1 to collect compiler errors',
          '3. edit source files under src/',
          '4. only then retry npm run build',
          'Do not use Python/shell workaround scripts or read dist/ until build succeeds.',
        ].join('\n'),
      };
    }
  }

  return { blocked: false };
}

export function checkDelegatePreflight(input: {
  task: string;
  buildDiagnosticGateActive?: boolean;
  branchBudget?: BranchBudgetTracker;
}): ToolPreflightDecision {
  const commands = extractRunCommandsFromDelegateTask(input.task);
  if (commands.length === 0) return { blocked: false };

  for (const command of commands) {
    if (input.buildDiagnosticGateActive && isBuildLikeCommand(command) && !isDiagnosticAllowedCommand(command)) {
      return {
        blocked: true,
        reason: 'delegate_build_blocked',
        message: [
          '[Harness / Diagnostic Gate] delegate_to_subagent blocked: sub-task would rerun blocked build commands.',
          `Detected command: ${command}`,
          'Fix source locally with read_file + npx tsc --noEmit + edit_file; do not delegate build/test pipeline while diagnostic gate is active.',
        ].join('\n'),
      };
    }

    if (input.branchBudget?.wouldBlockCommandRetry(command) && isHarnessVerificationCommand(command)) {
      return {
        blocked: true,
        reason: 'delegate_build_blocked',
        message: [
          '[Harness / BranchBudget] delegate_to_subagent blocked: sub-task would rerun a verification command already at retry cap.',
          `Detected command: ${command}`,
          'Read the last failure output, fix source, then retry from the main session after new evidence.',
        ].join('\n'),
      };
    }
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
    if (path && SOURCE_FILE_RE.test(path.replace(/\\/g, '/'))) return true;
  }
  return false;
}

export function buildDiagnosticGateMessage(): string {
  return [
    '[System / Build Diagnostic Gate]',
    'Build verification is blocked by BranchBudget after repeated failures.',
    'Switch to diagnosis mode: read failing src files, run npx tsc --noEmit, fix TypeScript errors, then retry build.',
    'Do not rerun the same npm run build, read dist/, or add Python workaround scripts.',
  ].join('\n');
}
