/**
 * 连续工具失败阶梯：轻提示 / 证据包 / 强警告的收集、注入与 ephemeral 清理。
 *
 * 阶梯（consecutiveToolFailures）：
 *   1 静默 | 2~3 轻提示 | 4~6 证据包（刷新） | 7~9 强警告 | ≥10 熔断
 */

import type { UnifiedMessage, ToolCall } from '../llm/types.js';
import type { VerificationOutputBuffer } from './verification-output-buffer.js';
import { extractRunCommand } from './branch-budget-tool-path.js';
import { toolCallSignature } from './harness-permission-runtime.js';
import { findLastFailedVerification } from './rebuild-escalation.js';
import { isHarnessVerificationCommand } from './verification-digest.js';

export type EphemeralFailureRecoveryKind = 'light' | 'evidence' | 'strong';

export const FAILURE_EVIDENCE_ENTRY_TAIL_CHARS = 6_000;
export const FAILURE_EVIDENCE_MAX_ENTRIES = 5;
export const FAILURE_EVIDENCE_TOTAL_CHARS = 20_000;

export interface FailureEvidenceEntry {
  toolName: string;
  label: string;
  body: string;
}

function findAssistantToolCall(
  messages: UnifiedMessage[],
  toolIndex: number,
  toolCallId: string | undefined,
): ToolCall | undefined {
  if (!toolCallId) return undefined;
  for (let j = toolIndex - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const match = m.toolCalls.find(tc => tc.id === toolCallId);
    if (match) return match;
    break;
  }
  return undefined;
}

export function isFailedToolResultContent(content: string): boolean {
  return content.includes('工具执行错误')
    || content.includes('Tool execution error')
    || content.includes('[BranchBudget / Blocked]')
    || content.includes('[Tool skipped]');
}

function stripToolErrorPrefix(content: string): string {
  if (content.includes('[BranchBudget / Blocked]')) {
    return content.trim();
  }
  return content
    .replace(/^(?:工具执行错误|Tool execution error)[:：][^\n]*\n+/m, '')
    .trim();
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[...truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

function labelForToolCall(tc: ToolCall | undefined, content: string): string {
  if (!tc) return 'unknown tool';
  if (tc.name === 'run_command') {
    const cmd = extractRunCommand(tc.arguments);
    return cmd ? `run_command: ${cmd}` : 'run_command';
  }
  const path = tc.arguments.path ?? tc.arguments.filePath ?? tc.arguments.file_path;
  if (typeof path === 'string' && path) {
    return `${tc.name}: ${path}`;
  }
  return tc.name;
}

/** 从对话历史收集最近失败 tool 结果（含 BranchBudget 拦截）。 */
export function collectFailureEvidenceEntries(
  messages: UnifiedMessage[],
  buffer?: VerificationOutputBuffer,
): FailureEvidenceEntry[] {
  const entries: FailureEvidenceEntry[] = [];

  for (let i = messages.length - 1; i >= 0 && entries.length < FAILURE_EVIDENCE_MAX_ENTRIES; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (!isFailedToolResultContent(msg.content)) continue;

    const tc = findAssistantToolCall(messages, i, msg.toolCallId);
    const body = stripToolErrorPrefix(msg.content);
    if (!body) continue;

    entries.unshift({
      toolName: tc?.name ?? 'tool',
      label: labelForToolCall(tc, msg.content),
      body: truncateTail(body, FAILURE_EVIDENCE_ENTRY_TAIL_CHARS),
    });
  }

  const verification = findLastFailedVerification(messages, buffer);
  if (verification?.outputBody && entries.every(e => !e.body.includes(verification.outputBody.slice(0, 80)))) {
    const body = truncateTail(verification.outputBody, FAILURE_EVIDENCE_ENTRY_TAIL_CHARS);
    entries.push({
      toolName: 'run_command',
      label: `verification (buffered): ${verification.command}`,
      body,
    });
  }

  return entries.slice(-FAILURE_EVIDENCE_MAX_ENTRIES);
}

export function buildFailureEvidencePackMessage(
  failureCount: number,
  entries: FailureEvidenceEntry[],
): string {
  const lines = [
    `[Failure Evidence — ${failureCount} consecutive all-failed rounds]`,
    'Analyze the evidence below and change strategy. Do NOT repeat identical failed tool calls or commands.',
    '',
  ];

  if (entries.length === 0) {
    lines.push('(No structured tool failure bodies found in recent history; inspect prior tool messages in context.)');
  } else {
    for (const entry of entries) {
      lines.push(`--- ${entry.label} ---`, entry.body, '');
    }
  }

  let message = lines.join('\n').trimEnd();
  if (message.length > FAILURE_EVIDENCE_TOTAL_CHARS) {
    message = truncateTail(message, FAILURE_EVIDENCE_TOTAL_CHARS);
  }
  return message;
}

export function buildLightFailureHintMessage(failureCount: number): string {
  return [
    `[System] ${failureCount} consecutive round(s) with all tool calls failed.`,
    'Check parameters, paths, and command syntax; do not repeat the identical call.',
  ].join(' ');
}

export function buildStrongFailureWarningMessage(failureCount: number): string {
  return [
    `[System] Warning: ${failureCount} consecutive rounds of tool calls have all failed. Multiple attempts have not succeeded.`,
    '',
    'You must:',
    '1. Stop retrying the same failed tool calls, commands, paths, or parameters',
    '2. Switch strategy: use a different tool, inspect paths/configuration, simplify the command, or ask for missing input',
    '3. If blocked, explain the exact blocker and evidence to the user',
    '',
    'You may still use tools, but only with a changed strategy. Do not repeat an identical failed operation.',
  ].join('\n');
}

export function purgeEphemeralFailureRecoveryMessages(
  messages: UnifiedMessage[],
  kind?: EphemeralFailureRecoveryKind,
): UnifiedMessage[] {
  return messages.filter((m) => {
    if (!m.ephemeralFailureRecovery) return true;
    if (!kind) return false;
    return m.ephemeralFailureRecovery !== kind;
  });
}

/** 原地移除 ephemeral 失败恢复消息，保持 msgs 与 state.messages 引用一致。 */
export function purgeEphemeralFailureRecoveryMessagesInPlace(
  messages: UnifiedMessage[],
  kind?: EphemeralFailureRecoveryKind,
): void {
  const next = purgeEphemeralFailureRecoveryMessages(messages, kind);
  messages.splice(0, messages.length, ...next);
}

export function roundHadSuccessfulVerification(
  executableToolCalls: ToolCall[],
  failedSignatures: string[],
): boolean {
  const failed = new Set(failedSignatures);
  for (const tc of executableToolCalls) {
    if (tc.name !== 'run_command') continue;
    if (failed.has(toolCallSignature(tc))) continue;
    const command = extractRunCommand(tc.arguments);
    if (command && isHarnessVerificationCommand(command)) return true;
  }
  return false;
}
