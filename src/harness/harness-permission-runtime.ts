import type { ToolCall } from '../llm/types.js';
import { getToolMetadata, isDestructiveCommand, isDestructiveOperation } from '../tools/tool-metadata.js';
import type { ToolPermissionRule } from './types.js';

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

/** 连续失败统计用的稳定键（工具名 + 序列化参数）。 */
export function toolCallSignature(tc: ToolCall): string {
  return `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
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
  return tc.name;
}
