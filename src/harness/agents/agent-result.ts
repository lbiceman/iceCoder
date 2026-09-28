/**
 * 子 Agent 结果汇总：状态映射、改动统计与 `[Agent Result]` 文本。
 * 改动文件与命令只取系统工具记录，不采信子 Agent 自述。
 */

import type { StopReason } from '../types.js';

export type AgentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'max_rounds'
  | 'cancelled';

export type AgentTerminalStatus = Exclude<AgentStatus, 'queued' | 'running'>;

export interface AgentFileChange {
  path: string;
  additions: number;
  deletions: number;
  created?: boolean;
  deleted?: boolean;
  /** 由 run_command 前后清单差异发现（无法事先加租约） */
  viaCommand?: boolean;
}

export interface AgentCommandRecord {
  toolCallId: string;
  command: string;
  exitCode: number | null;
  success: boolean;
  /** 后台启动 / 运行中等未终结状态 */
  pending?: boolean;
}

export interface AgentLeaseReject {
  path: string;
  toolName: string;
  holderAgentId: string;
  holderDescription: string;
  at: number;
}

export interface AgentCommandConflict {
  path: string;
  command: string;
  otherAgentId: string;
  otherDescription: string;
}

/** 前端卡片与 REST 共用的子 Agent 视图。 */
export interface AgentView {
  agentId: string;
  parentToolCallId: string;
  messageId: string;
  type: string;
  description: string;
  status: AgentStatus;
  startedAt?: number;
  finishedAt?: number;
  rounds: number;
  toolCalls: number;
  tokens: number;
  filesChanged: Array<{ path: string; additions: number; deletions: number }>;
  commands: Array<{ command: string; exitCode: number | null }>;
  leaseRejects: number;
  currentActivity?: string;
  reportPreview?: string;
  error?: string;
  /** 进程在子 Agent 运行中退出，记录未正常收尾 */
  interrupted?: boolean;
}

export const AGENT_REPORT_MAX_CHARS = 12_000;
export const AGENT_REPORT_PREVIEW_CHARS = 600;

export function mapStopReasonToAgentStatus(
  stopReason: StopReason | undefined,
  abortReason?: 'timeout' | 'cancelled',
): { status: AgentTerminalStatus; reason?: string } {
  if (abortReason === 'timeout') return { status: 'timeout' };
  switch (stopReason) {
    case 'model_done':
      return { status: 'completed' };
    case 'max_rounds':
      return { status: 'max_rounds' };
    case 'timeout':
      return { status: 'timeout' };
    case 'user_abort':
      return { status: 'cancelled' };
    case undefined:
      return abortReason === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', reason: 'unknown' };
    default:
      return { status: 'failed', reason: stopReason };
  }
}

export function formatAgentDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/** 行级多重集合差异：足够给出 +N -M，避免对大文件做 O(n²) LCS。 */
export function countLineChanges(before: string | null, after: string | null): { additions: number; deletions: number } {
  const count = (text: string | null): Map<string, number> => {
    const map = new Map<string, number>();
    if (text == null || text === '') return map;
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of b) additions += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) deletions += Math.max(0, n - (b.get(line) ?? 0));
  return { additions, deletions };
}

export function truncateAgentReport(report: string, logHint?: string): string {
  if (report.length <= AGENT_REPORT_MAX_CHARS) return report;
  const tail = logHint ? `\n\n[report truncated; full transcript: ${logHint}]` : '\n\n[report truncated]';
  return report.slice(0, AGENT_REPORT_MAX_CHARS) + tail;
}

export interface AgentResultSummary {
  agentId: string;
  type: string;
  status: AgentTerminalStatus;
  statusReason?: string;
  durationMs: number;
  rounds: number;
  toolCalls: number;
  tokens: number;
  filesChanged: AgentFileChange[];
  commands: AgentCommandRecord[];
  leaseRejects: AgentLeaseReject[];
  commandConflicts: AgentCommandConflict[];
  report: string;
  error?: string;
  transcriptPath?: string;
}

function formatFileChange(f: AgentFileChange): string {
  const tag = f.deleted ? ' [deleted]' : f.created ? ' [new]' : '';
  const via = f.viaCommand ? ' (via command)' : '';
  return `${f.path} (+${f.additions} -${f.deletions})${tag}${via}`;
}

function formatCommand(c: AgentCommandRecord): string {
  if (c.pending) return `${c.command} → running in background`;
  return `${c.command} → exit ${c.exitCode ?? (c.success ? 0 : '?')}`;
}

export function formatAgentResult(summary: AgentResultSummary): string {
  const header = `[Agent Result] agent=${summary.type} id=${summary.agentId} status=${summary.status}`
    + (summary.statusReason ? ` reason=${summary.statusReason}` : '');
  const lines = [
    header,
    `duration=${formatAgentDuration(summary.durationMs)} rounds=${summary.rounds} toolCalls=${summary.toolCalls} tokens=${formatTokenCount(summary.tokens)}`,
    summary.filesChanged.length > 0
      ? `files changed (${summary.filesChanged.length}): ${summary.filesChanged.map(formatFileChange).join(', ')}`
      : 'files changed (0): none',
    summary.commands.length > 0
      ? `commands: ${summary.commands.map(formatCommand).join('; ')}`
      : 'commands: none',
  ];
  if (summary.leaseRejects.length > 0) {
    lines.push(`write lease rejects (${summary.leaseRejects.length}): ${summary.leaseRejects
      .map(r => `${r.path} held by "${r.holderDescription}"`)
      .join('; ')}`);
  }
  if (summary.commandConflicts.length > 0) {
    lines.push(`command conflicts: ${summary.commandConflicts
      .map(c => `${c.path} changed by \`${c.command}\` while held by "${c.otherDescription}"`)
      .join('; ')}`);
  }
  if (summary.error) lines.push(`error: ${summary.error}`);
  lines.push('--- report ---');
  lines.push(truncateAgentReport(summary.report.trim() || '(no final report)', summary.transcriptPath));
  return lines.join('\n');
}
