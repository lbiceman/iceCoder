import type { ToolCall, UnifiedMessage } from '../llm/types.js';
import { getToolMetadata } from '../tools/tool-metadata.js';
import type {
  ToolEffect,
  ToolReceipt,
  ToolResult,
  ToolResultStatus,
  ToolRisk,
} from '../tools/types.js';
import {
  isDestructiveToolCall,
  toolCallSignature,
} from './harness-permission-runtime.js';

export type OperationDisposition =
  | 'executed'
  | 'execution_fail'
  | 'policy_block'
  | 'user_denied';

export type OperationReversibility =
  | 'reversible'
  | 'compensatable'
  | 'irreversible';

export interface OperationOutcome {
  toolCallId: string;
  toolName: string;
  status: ToolResultStatus;
  effect: ToolEffect;
  risk: ToolRisk;
  disposition: OperationDisposition;
  scope: string;
  receipt?: ToolReceipt;
  error?: string;
  at: number;
  /** 操作发生后的回退能力；旧调用方可不提供。 */
  reversibility?: OperationReversibility;
  /** 标记从旧 checkpoint 补建、并非真实工具回执的结果。 */
  legacySynthetic?: boolean;
}

export interface NormalizeOperationOutcomeOptions {
  disposition?: OperationDisposition;
  now?: () => number;
}

export interface CollectToolOperationOutcomesOptions {
  toolCalls: readonly ToolCall[];
  messages: readonly UnifiedMessage[];
  failedSignatures?: readonly string[];
  policyBlockedSignatures?: readonly string[];
  now?: () => number;
}

export class OperationOutcomeLedger {
  private readonly outcomesByScope = new Map<string, OperationOutcome>();
  private readonly outcomesById = new Map<string, OperationOutcome>();

  record(outcome: OperationOutcome): void {
    const copy = cloneOperationOutcome(outcome);
    const previous = this.outcomesById.get(copy.toolCallId);
    if (previous && previous.scope !== copy.scope) {
      this.outcomesByScope.delete(previous.scope);
    }
    const superseded = this.outcomesByScope.get(copy.scope);
    if (superseded && superseded.toolCallId !== copy.toolCallId) {
      this.outcomesById.delete(superseded.toolCallId);
    }
    this.outcomesByScope.set(copy.scope, copy);
    this.outcomesById.set(copy.toolCallId, copy);
  }

  list(): OperationOutcome[] {
    return [...this.outcomesByScope.values()]
      .sort((a, b) => a.at - b.at)
      .map(cloneOperationOutcome);
  }

  getByToolCallId(toolCallId: string): OperationOutcome | undefined {
    const outcome = this.outcomesById.get(toolCallId);
    return outcome ? cloneOperationOutcome(outcome) : undefined;
  }

  /** 返回可安全持久化的独立快照。 */
  snapshot(): OperationOutcome[] {
    return this.list();
  }

  /** 用快照完整替换账本；重复恢复同一快照不会累加状态。 */
  replace(snapshot: readonly OperationOutcome[]): void {
    this.outcomesByScope.clear();
    this.outcomesById.clear();
    for (const outcome of snapshot) this.record(outcome);
  }

  restore(snapshot: readonly OperationOutcome[]): void {
    this.replace(snapshot);
  }

  hasPending(): boolean {
    return this.list().some(item =>
      item.status === 'pending' || item.status === 'awaiting_approval',
    );
  }

  latestPending(): OperationOutcome | undefined {
    return this.list().reverse().find(item =>
      item.status === 'pending' || item.status === 'awaiting_approval',
    );
  }

  latestUnresolvedFailure(): OperationOutcome | undefined {
    return this.list().reverse().find(item => item.status === 'failed');
  }

  latestHighRiskWithoutReceipt(): OperationOutcome | undefined {
    return this.list().reverse().find(item =>
      item.status === 'completed' && item.risk === 'high' && !hasUsefulReceipt(item.receipt),
    );
  }

  hasCompletedMutation(): boolean {
    return this.list().some(item =>
      item.status === 'completed' && item.effect !== 'observe',
    );
  }

  hasIndependentReceipt(): boolean {
    return this.list().some(item =>
      item.status === 'completed'
      && item.effect !== 'observe'
      && hasUsefulReceipt(item.receipt),
    );
  }
}

/**
 * 从 Harness 已写入的 tool message 与执行统计提取标准操作结果。
 * 普通工具轮与停时 synthetic 工具调用共用此处，避免两套 block/approval 判定。
 */
export function collectToolOperationOutcomes(
  options: CollectToolOperationOutcomesOptions,
): OperationOutcome[] {
  const failed = new Set(options.failedSignatures ?? []);
  const policyBlocked = new Set(options.policyBlockedSignatures ?? []);
  const outcomes: OperationOutcome[] = [];

  for (const toolCall of options.toolCalls) {
    const toolMessage = [...options.messages].reverse().find(
      message => message.role === 'tool' && message.toolCallId === toolCall.id,
    );
    if (!toolMessage || typeof toolMessage.content !== 'string') continue;

    const output = toolMessage.content;
    const signature = toolCallSignature(toolCall);
    const userDenied = /user denied/i.test(output);
    const implicitPolicyBlock =
      /denied by policy|\[.*blocked\]|not available in this turn/i.test(output);
    const isPolicyBlocked = policyBlocked.has(signature) || implicitPolicyBlock;
    const isFailed = failed.has(signature)
      || isPolicyBlocked
      || userDenied
      || /tool execution was interrupted/i.test(output);
    const awaitingApproval =
      /requires? (?:shell mandatory )?confirmation.*no .*handler/i.test(output);

    outcomes.push(normalizeOperationOutcome(toolCall, {
      success: !isFailed && !awaitingApproval,
      output,
      ...(isFailed ? { error: output.slice(0, 500) } : {}),
      ...(awaitingApproval ? { status: 'awaiting_approval' as const } : {}),
    }, {
      disposition: userDenied
        ? 'user_denied'
        : isPolicyBlocked
          ? 'policy_block'
          : isFailed
            ? 'execution_fail'
            : 'executed',
      now: options.now,
    }));
  }

  return outcomes;
}

export function recordToolOperationOutcomes(
  ledger: OperationOutcomeLedger | undefined,
  options: CollectToolOperationOutcomesOptions,
): OperationOutcome[] {
  const outcomes = collectToolOperationOutcomes(options);
  if (ledger) {
    for (const outcome of outcomes) ledger.record(outcome);
  }
  return outcomes;
}

function cloneOperationOutcome(outcome: OperationOutcome): OperationOutcome {
  return {
    ...outcome,
    ...(outcome.receipt ? { receipt: { ...outcome.receipt } } : {}),
  };
}

export function normalizeOperationOutcome(
  toolCall: ToolCall,
  result: ToolResult,
  options: NormalizeOperationOutcomeOptions = {},
): OperationOutcome {
  const parsed = parseObject(result.output);
  const status = result.status ?? inferStatus(result, parsed);
  const effect = result.effect ?? inferEffect(toolCall.name);
  const risk = result.risk ?? (isDestructiveToolCall(toolCall) ? 'high' : 'low');
  const receipt = result.receipt ?? inferReceipt(toolCall, result, parsed, status);
  const disposition = options.disposition
    ?? (result.success ? 'executed' : inferFailureDisposition(result));
  const reversibility = inferReversibility(toolCall.name, effect, risk);

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    status,
    effect,
    risk,
    disposition,
    reversibility,
    scope: inferScope(toolCall, parsed, receipt),
    ...(receipt ? { receipt } : {}),
    ...(result.error ? { error: result.error } : {}),
    at: (options.now ?? Date.now)(),
  };
}

function inferStatus(
  result: ToolResult,
  parsed: Record<string, unknown> | null,
): ToolResultStatus {
  const text = `${result.error ?? ''}\n${result.output}`;
  if (/requires? (?:shell mandatory )?confirmation|awaiting[_ -]approval/i.test(text)) {
    return 'awaiting_approval';
  }
  if (!result.success || /user denied|denied by policy|tool execution was interrupted/i.test(text)) {
    return 'failed';
  }

  const rawStatus = String(parsed?.status ?? '').toLowerCase();
  const mode = String(parsed?.mode ?? '').toLowerCase();
  const lifespan = String(parsed?.lifespan ?? '').toLowerCase();
  if (lifespan === 'detached' || /\blifespan:\s*detached\b/i.test(result.output)) {
    return 'completed';
  }
  if (
    ['pending', 'running', 'started', 'queued', 'awaiting_input'].includes(rawStatus)
    || ((mode === 'background' || mode === 'escalated') && rawStatus !== 'completed')
    || /\bstatus:\s*(pending|running)\b/i.test(result.output)
    || /running in the background/i.test(result.output)
  ) {
    return 'pending';
  }
  if (['failed', 'timeout', 'killed', 'cancelled'].includes(rawStatus)) return 'failed';
  if (typeof parsed?.exitCode === 'number' && parsed.exitCode !== 0) return 'failed';
  return 'completed';
}

function inferReversibility(
  toolName: string,
  effect: ToolEffect,
  risk: ToolRisk,
): OperationReversibility {
  const metadata = getToolMetadata(toolName);
  if (metadata.isReadOnly || effect === 'observe') return 'reversible';
  if (effect === 'external_change' || metadata.tags.includes('network')) return 'irreversible';
  if (metadata.isDestructive || metadata.tags.includes('file_delete') || risk === 'high') {
    return 'compensatable';
  }
  if (effect === 'local_change') return 'reversible';
  if (metadata.tags.includes('shell')) return 'compensatable';
  return 'reversible';
}

function inferEffect(toolName: string): ToolEffect {
  const metadata = getToolMetadata(toolName);
  if (metadata.isReadOnly) return 'observe';
  if (metadata.tags.includes('file_write') || metadata.tags.includes('file_delete')) {
    return 'local_change';
  }
  if (metadata.tags.includes('network')) return 'external_change';
  return 'execute';
}

function inferReceipt(
  toolCall: ToolCall,
  result: ToolResult,
  parsed: Record<string, unknown> | null,
  status: ToolResultStatus,
): ToolReceipt | undefined {
  const operationId = firstString(
    parsed?.taskId,
    parsed?.task_id,
    parsed?.operationId,
    parsed?.operation_id,
    parsed?.id,
  );
  const target = extractTarget(toolCall.arguments);
  const exitCode = typeof parsed?.exitCode === 'number' ? parsed.exitCode : undefined;
  const version = firstString(parsed?.version, parsed?.etag, parsed?.revision);
  const summary = status === 'completed' && result.output.trim()
    ? result.output.trim().replace(/\s+/g, ' ').slice(0, 240)
    : undefined;

  if (!operationId && !target && exitCode === undefined && !version && !summary) return undefined;
  return {
    ...(operationId ? { operationId } : {}),
    ...(target ? { target } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(version ? { version } : {}),
    ...(summary ? { summary } : {}),
  };
}

function inferScope(
  toolCall: ToolCall,
  parsed: Record<string, unknown> | null,
  receipt: ToolReceipt | undefined,
): string {
  const operationId = receipt?.operationId
    ?? firstString(
      toolCall.arguments?.task_id,
      toolCall.arguments?.taskId,
      parsed?.taskId,
      parsed?.task_id,
    );
  if (operationId) return `operation:${operationId}`;

  const target = receipt?.target ?? extractTarget(toolCall.arguments);
  if (target) return `target:${target.toLowerCase()}`;

  return `${toolCall.name}:${stableArgs(toolCall.arguments ?? {})}`;
}

function inferFailureDisposition(result: ToolResult): OperationDisposition {
  const text = `${result.error ?? ''}\n${result.output}`;
  if (/user denied/i.test(text)) return 'user_denied';
  if (/denied by policy|\[.*blocked\]|not available in this turn/i.test(text)) return 'policy_block';
  return 'execution_fail';
}

function extractTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'filePath', 'file_path', 'target', 'url', 'command', 'cmd']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stableArgs(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
  ).slice(0, 240);
}

function hasUsefulReceipt(receipt: ToolReceipt | undefined): boolean {
  return !!receipt && (
    !!receipt.operationId
    || receipt.exitCode !== undefined
    || !!receipt.version
    || !!receipt.summary
  );
}

function parseObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === 'string' && value.trim().length > 0,
  )?.trim();
}
