import type { BranchBudgetTracker } from './branch-budget.js';
import { extractRunCommand } from './branch-budget-tool-path.js';
import type { ToolCall } from '../llm/types.js';
import type { TaskState } from './task-state.js';
import { isBuildVerificationCommand, isHarnessVerificationCommand } from './verification-digest.js';
import { extractRunCommandsFromDelegateTask } from './verification-output-buffer.js';
import { workspaceFileExists } from './workspace-path-guard.js';
import {
  checkHostGuardWritePreflight,
} from '../tools/shell-host-guard.js';
import { analyzeShellSandbox } from '../tools/shell-sandbox.js';

export interface ToolPreflightInput {
  toolName: string;
  args: Record<string, unknown>;
  branchBudget?: BranchBudgetTracker;
  taskState?: TaskState;
  buildDiagnosticGateActive?: boolean;
  workspaceRoot?: string;
  lockedWorkspaceRoot?: string;
  /** 同路径 missing-file preflight 拦截次数（由 HarnessRunState 持有）。 */
  missingFileAttempts?: Map<string, number>;
}

export interface ToolPreflightDecision {
  blocked: boolean;
  reason?: 'dist_read' | 'build_diagnostic_gate' | 'delegate_build_blocked' | 'missing_file' | 'missing_file_repeat' | 'host_kill' | 'shell_blacklist';
  message?: string;
  hostKillLabel?: string;
}

const MISSING_FILE_TARGET_TOOLS = new Set(['read_file', 'edit_file', 'patch_file', 'append_file']);
const DIST_ARTIFACT_RE = /^(?:dist|build|out)\//i;
const SOURCE_FILE_RE = /^src\/.*\.(ts|tsx|js|jsx)$/i;

/** delegate 任务文案是否暗示会跑 build / e2e 等验收流水线（regex 未抽出命令时的兜底）。 */
const DELEGATE_READ_ONLY_RE = /\b(read[_\s-]?only|inspect|explore|analyze|analysis|explain|list_dir|read_file|查看|分析|只读|探索|review\s+code)\b/i;

const DELEGATE_VERIFICATION_PIPELINE_RES: RegExp[] = [
  /\bnpm\s+run\s+(?:build|test:e2e)\b/i,
  /\btest:e2e\b/i,
  /\bvite\s+build\b/i,
  /\bnpx\s+tsc\b(?![^\n]*--no[- ]?emit)/i,
  /\b(run|execute|retry)\b[^\n]{0,40}\b(build|test:e2e)\b/i,
  /\b(build|compile|验收|构建)\b[^\n]{0,30}\b(fix|until|pass|成功|通过)\b/i,
];

export function taskMentionsBlockedVerificationPipeline(task: string): boolean {
  const text = task.trim();
  if (!text) return false;
  const mentionsPipeline = DELEGATE_VERIFICATION_PIPELINE_RES.some(re => re.test(text));
  if (!mentionsPipeline) return false;
  if (DELEGATE_READ_ONLY_RE.test(text) && !/\b(build|test:e2e|vite\s+build|npm\s+run)\b/i.test(text)) {
    return false;
  }
  return true;
}

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

function extractTargetPath(args: Record<string, unknown>): string | undefined {
  const raw = args.path ?? args.file_path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
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

export function checkToolPreflight(input: ToolPreflightInput): ToolPreflightDecision {
  const path = extractTargetPath(input.args);

  const missing = checkMissingFilePreflight({
    toolName: input.toolName,
    path,
    workspaceRoot: input.workspaceRoot,
    lockedWorkspaceRoot: input.lockedWorkspaceRoot,
    missingFileAttempts: input.missingFileAttempts,
  });
  if (missing.blocked) return missing;

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

  if (input.toolName === 'run_command') {
    const command = extractRunCommand(input.args);
    if (command) {
      const sandbox = analyzeShellSandbox(command, { workDir: input.workspaceRoot });
      if (sandbox.blocked) {
        return {
          blocked: true,
          reason: sandbox.reason === 'blacklist' ? 'shell_blacklist' : 'host_kill',
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

export function checkDelegatePreflight(input: {
  task: string;
  workspaceRoot?: string;
  buildDiagnosticGateActive?: boolean;
  branchBudget?: BranchBudgetTracker;
}): ToolPreflightDecision {
  const taskSandbox = analyzeShellSandbox(input.task, { workDir: input.workspaceRoot });
  if (taskSandbox.blocked) {
    return {
      blocked: true,
      reason: taskSandbox.reason === 'blacklist' ? 'shell_blacklist' : 'host_kill',
      hostKillLabel: taskSandbox.matchLabel,
      message: taskSandbox.message ?? '[Sandbox / Blocked]',
    };
  }

  const commands = extractRunCommandsFromDelegateTask(input.task);

  for (const command of commands) {
    const sandbox = analyzeShellSandbox(command, { workDir: input.workspaceRoot });
    if (sandbox.blocked) {
      return {
        blocked: true,
        reason: sandbox.reason === 'blacklist' ? 'shell_blacklist' : 'host_kill',
        hostKillLabel: sandbox.matchLabel,
        message: sandbox.message ?? '[Sandbox / Blocked]',
      };
    }

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

  if (input.buildDiagnosticGateActive && taskMentionsBlockedVerificationPipeline(input.task)) {
    return {
      blocked: true,
      reason: 'delegate_build_blocked',
      message: [
        '[Harness / Diagnostic Gate] delegate_to_subagent blocked: sub-task text implies build/test verification work.',
        'Fix source locally with read_file + npx tsc --noEmit + edit_file; do not delegate build/test pipeline while diagnostic gate is active.',
        `Task preview: ${input.task.trim().slice(0, 200)}`,
      ].join('\n'),
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
