import type { ToolCall } from '../llm/types.js';
import { analyzeShellSandbox } from '../tools/shell-sandbox.js';
import {
  classifyShellCollabCommandRisk,
  hashNormalizedShellCommand,
  redactShellCommandForDisplay,
  type ShellCollabCommandRisk,
} from '../tools/shell-collab-command-risk.js';
import { SHELL_COLLAB_TOOL_NAMES } from '../tools/shell-collab-tools.js';
import { redactToolArguments } from '../tools/tool-argument-redaction.js';
import { getToolMetadata, isDestructiveCommand, isDestructiveOperation } from '../tools/tool-metadata.js';
import type { ToolPermissionRule } from './types.js';

export const SHELL_COLLAB_COMMAND_TOOLS = new Set(['shell_exec', 'interactive_shell']);
const SHELL_COLLAB_TOOLS = new Set<string>(SHELL_COLLAB_TOOL_NAMES);

export interface ShellMandatoryConfirmRequest {
  toolName: string;
  args: Record<string, unknown>;
  command: string;
  commandDisplay: string;
  taskId: string;
  sessionId: string;
  normalizedCommandHash: string;
  risk: ShellCollabCommandRisk;
}

export interface ShellMandatoryConfirmDecision {
  required: boolean;
  hardBlocked?: boolean;
  hardBlockMessage?: string;
  request?: ShellMandatoryConfirmRequest;
}

/** 同一 Harness run 内 mandatory-confirm 拒绝去重键。 */
export function shellMandatoryConfirmKey(
  request: Pick<ShellMandatoryConfirmRequest, 'sessionId' | 'taskId' | 'normalizedCommandHash'>,
): string {
  return `${request.sessionId}\u0000${request.taskId}\u0000${request.normalizedCommandHash}`;
}

/** 从 shell_exec / interactive_shell(start) 提取待检命令文本。 */
export function extractShellCollabCommandFromToolCall(tc: ToolCall): string | null {
  if (tc.name === 'shell_exec') {
    const command = (tc.arguments as Record<string, unknown>)?.command;
    return typeof command === 'string' && command.trim() ? command.trim() : null;
  }
  if (tc.name === 'interactive_shell') {
    const action = (tc.arguments as Record<string, unknown>)?.action;
    if (action !== 'start') return null;
    const command = (tc.arguments as Record<string, unknown>)?.command;
    return typeof command === 'string' && command.trim() ? command.trim() : null;
  }
  return null;
}

export function isShellCollabCommandTool(toolName: string): boolean {
  return SHELL_COLLAB_COMMAND_TOOLS.has(toolName);
}

export function isShellCollabTool(toolName: string): boolean {
  return SHELL_COLLAB_TOOLS.has(toolName);
}

/**
 * Shell 协作命令权限：hard block > shellMandatoryConfirm > 未命中直行。
 * 未命中可配置正则时不进入普通 permission。
 */
export function resolveShellMandatoryConfirm(
  tc: ToolCall,
  options: {
    sessionId: string;
    workspaceRoot?: string;
    configPath?: string;
  },
): ShellMandatoryConfirmDecision {
  const command = extractShellCollabCommandFromToolCall(tc);
  if (!command) {
    return { required: false };
  }

  const sandbox = analyzeShellSandbox(command, {
    workDir: options.workspaceRoot,
    configPath: options.configPath,
    includeBlacklist: false,
  });
  if (sandbox.blocked) {
    return {
      required: false,
      hardBlocked: true,
      hardBlockMessage: sandbox.message ?? '[Sandbox / Blocked]',
    };
  }

  const risk = classifyShellCollabCommandRisk(command, { configPath: options.configPath });
  if (!risk) {
    return { required: false };
  }

  const taskIdRaw = (tc.arguments as Record<string, unknown>)?.task_id;
  const taskId = typeof taskIdRaw === 'string' && taskIdRaw.trim()
    ? taskIdRaw.trim()
    : tc.name === 'interactive_shell'
      ? '__shell_start__'
      : '';

  return {
    required: true,
    request: {
      toolName: tc.name,
      args: tc.arguments ?? {},
      command,
      commandDisplay: redactShellCommandForDisplay(command),
      taskId,
      sessionId: options.sessionId,
      normalizedCommandHash: hashNormalizedShellCommand(risk.normalized),
      risk,
    },
  };
}

/**
 * 判断工具调用是否具有破坏性。
 *
 * `fs_operation` / `run_command` 在运行时解析参数；其余工具使用元数据 `isDestructive`。
 */
export function isDestructiveToolCall(tc: ToolCall): boolean {
  if (tc.name === 'fs_operation') {
    const op = (tc.arguments as Record<string, any>)?.operation as string | undefined;
    return op ? isDestructiveOperation(op) : false;
  }
  if (tc.name === 'run_command') {
    const cmd = (tc.arguments as Record<string, any>)?.command as string | undefined;
    return cmd ? isDestructiveCommand(cmd) : false;
  }
  return getToolMetadata(tc.name).isDestructive;
}

/**
 * 配置的 pattern 命中则直接采用规则权限；否则破坏性工具默认为 `confirm`。
 */
export function resolveToolPermission(
  tc: ToolCall,
  permissionRules: ToolPermissionRule[],
): { permission: 'allow' | 'confirm' | 'deny'; reason?: string } {
  for (const rule of permissionRules) {
    if (matchesPermissionPattern(rule.pattern, tc.name)) {
      return { permission: rule.permission, reason: rule.reason };
    }
  }

  return {
    permission: isDestructiveToolCall(tc) ? 'confirm' : 'allow',
    reason: isDestructiveToolCall(tc) ? 'Destructive operation requires confirmation' : undefined,
  };
}

/** Glob 风格：`*`、精确工具名或 `*` 展开的 `^escaped$` 正则。 */
export function matchesPermissionPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*' || pattern === toolName) return true;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(toolName);
}

/** 连续失败统计用的稳定键（工具名 + 脱敏后参数）。凭证不得进入 checkpoint / resilience。 */
export function toolCallSignature(tc: ToolCall): string {
  const safeArgs = redactToolArguments(tc.name, tc.arguments ?? {});
  return `${tc.name}:${JSON.stringify(safeArgs)}`;
}

/**
 * 累加失败签名计数，返回本轮起已连续失败 ≥2 次的签名（供熔断/强提示）。
 */
export function collectRepeatedFailures(
  _toolCalls: ToolCall[],
  failedSignatures: string[],
  counts: Map<string, number>,
): string[] {
  const repeated: string[] = [];
  for (const sig of failedSignatures) {
    const next = (counts.get(sig) ?? 0) + 1;
    counts.set(sig, next);
    if (next >= 2) repeated.push(sig);
  }
  return repeated;
}

/**
 * 格式化确认时的工具名称，附加具体的操作信息。
 * 例如：`fs_operation (delete)`、`run_command (rm -rf node_modules)`。
 */
export function formatConfirmToolName(tc: ToolCall): string {
  if (tc.name === 'fs_operation') {
    const op = (tc.arguments as Record<string, any>)?.operation as string | undefined;
    return op ? `fs_operation (${op})` : tc.name;
  }
  if (tc.name === 'run_command') {
    const cmd = (tc.arguments as Record<string, any>)?.command as string | undefined;
    if (cmd) {
      const short = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
      return `run_command (${short})`;
    }
  }
  if (tc.name === 'shell_exec') {
    const cmd = (tc.arguments as Record<string, any>)?.command as string | undefined;
    if (cmd) {
      const short = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
      return `shell_exec (${short})`;
    }
  }
  if (tc.name === 'interactive_shell') {
    const cmd = (tc.arguments as Record<string, any>)?.command as string | undefined;
    if (cmd) {
      const short = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
      return `interactive_shell start (${short})`;
    }
  }
  return tc.name;
}
