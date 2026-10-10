/**
 * 会话级后台子 Agent 注册表（进程内，跨轮存活）。
 *
 * 前台子 Agent 的结果由 `task` 工具同步返回；后台子 Agent（`task` 的
 * `run_in_background:true`）在启动它的那一轮结束后仍可能继续运行，因此需要一个
 * 独立于「单轮 spawner」的登记处：
 *
 * - 记录每个后台子 Agent 的类型、描述、状态；
 * - 终态时保留 `[Agent Result]` 文本，供主 Agent **下一轮自动注入**或经
 *   `check_agent` 取走（取一次即清空，避免重复注入）。
 *
 * 与 `A0` 会话的绑定由调用方（Web 层）负责，本模块只按 sessionId 隔离。
 */

import type { AgentStatus } from './agent-result.js';

export interface BackgroundAgentEntry {
  agentId: string;
  sessionId: string;
  /** 启动它的 task 工具调用 id（用于取回改动汇总） */
  toolCallId: string;
  type: string;
  description: string;
  startedAt: number;
  status: AgentStatus;
  /** 终态后的最终报告文本（未取走前保留） */
  output?: string;
}

/** 取走的后台结果：报告文本 + 对应 task 调用 id（供合并改动与验证证据）。 */
export interface DrainedBackgroundResult {
  agentId: string;
  toolCallId: string;
  output: string;
}

export class AgentBackgroundHub {
  private readonly bySession = new Map<string, Map<string, BackgroundAgentEntry>>();

  private bucket(sessionId: string): Map<string, BackgroundAgentEntry> {
    let map = this.bySession.get(sessionId);
    if (!map) {
      map = new Map();
      this.bySession.set(sessionId, map);
    }
    return map;
  }

  register(entry: Omit<BackgroundAgentEntry, 'status'>): void {
    this.bucket(entry.sessionId).set(entry.agentId, { ...entry, status: 'running' });
  }

  finish(agentId: string, status: AgentStatus, output: string): void {
    const found = this.find(agentId);
    if (!found) return;
    found.entry.status = status;
    found.entry.output = output;
  }

  get(agentId: string): BackgroundAgentEntry | undefined {
    const found = this.find(agentId);
    return found ? { ...found.entry } : undefined;
  }

  list(sessionId: string): BackgroundAgentEntry[] {
    const map = this.bySession.get(sessionId);
    if (!map) return [];
    return [...map.values()]
      .map(e => ({ ...e }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 还在运行（未终态）的后台子 Agent 数量。 */
  liveCount(sessionId: string): number {
    const map = this.bySession.get(sessionId);
    if (!map) return 0;
    let n = 0;
    for (const e of map.values()) {
      if (e.status === 'running' || e.status === 'queued') n++;
    }
    return n;
  }

  /** 取走一个 Agent 的终态报告（取一次即清空）。 */
  takeOutput(agentId: string): string | undefined {
    const found = this.find(agentId);
    if (!found || found.entry.output === undefined) return undefined;
    const out = found.entry.output;
    delete found.entry.output;
    return out;
  }

  /** 取走该会话所有已结束、尚未注入的报告。 */
  drainOutputs(sessionId: string): DrainedBackgroundResult[] {
    const map = this.bySession.get(sessionId);
    if (!map) return [];
    const out: DrainedBackgroundResult[] = [];
    for (const entry of map.values()) {
      if (entry.output === undefined) continue;
      out.push({ agentId: entry.agentId, toolCallId: entry.toolCallId, output: entry.output });
      delete entry.output;
    }
    return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  /** 该会话是否有「已结束、尚未注入」的报告。 */
  hasPendingOutputs(sessionId: string): boolean {
    const map = this.bySession.get(sessionId);
    if (!map) return false;
    for (const entry of map.values()) {
      if (entry.output !== undefined) return true;
    }
    return false;
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  reset(): void {
    this.bySession.clear();
  }

  private find(agentId: string): { entry: BackgroundAgentEntry } | undefined {
    for (const map of this.bySession.values()) {
      const entry = map.get(agentId);
      if (entry) return { entry };
    }
    return undefined;
  }
}

/** 进程级默认注册表：Web 会话共用。 */
export const sessionAgentBackgroundHub = new AgentBackgroundHub();

export function formatBackgroundInjection(
  drained: ReadonlyArray<{ agentId: string; output: string }>,
): string {
  return [
    '[Background sub-agent results]',
    'Sub-agents you launched with task(run_in_background:true) have finished while you were working. Review their reports and follow up as needed.',
    '',
    ...drained.map(d => d.output),
  ].join('\n');
}
