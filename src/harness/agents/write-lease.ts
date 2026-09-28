/**
 * 并行子 Agent 的文件写租约。
 *
 * 子 Agent 第一次写某个文件时取得租约，持有到该子 Agent 结束。
 * 其它子 Agent 写同一文件会被拒绝；主 Agent 不受限制（它在 task 期间阻塞）。
 */

import path from 'node:path';

export interface WriteLeaseHolder {
  agentId: string;
  description: string;
  /** 持有者最近一次通过写工具写入该文件的时间 */
  lastWriteAt: number;
}

export type WriteLeaseAcquireResult =
  | { ok: true }
  | { ok: false; holder: WriteLeaseHolder };

function leaseKey(workspaceRoot: string, filePath: string): string {
  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const normalized = abs.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export class WriteLeaseRegistry {
  private readonly leases = new Map<string, WriteLeaseHolder>();

  acquire(
    workspaceRoot: string,
    filePath: string,
    agent: { agentId: string; description: string },
    now: number = Date.now(),
  ): WriteLeaseAcquireResult {
    const key = leaseKey(workspaceRoot, filePath);
    const existing = this.leases.get(key);
    if (existing && existing.agentId !== agent.agentId) {
      return { ok: false, holder: { ...existing } };
    }
    this.leases.set(key, { agentId: agent.agentId, description: agent.description, lastWriteAt: now });
    return { ok: true };
  }

  holderOf(workspaceRoot: string, filePath: string): WriteLeaseHolder | undefined {
    const holder = this.leases.get(leaseKey(workspaceRoot, filePath));
    return holder ? { ...holder } : undefined;
  }

  releaseAgent(agentId: string): void {
    for (const [key, holder] of this.leases) {
      if (holder.agentId === agentId) this.leases.delete(key);
    }
  }

  size(): number {
    return this.leases.size;
  }
}

/** 进程级默认租约表：同一 workspace 的并行子 Agent 共享。 */
export const defaultWriteLeaseRegistry = new WriteLeaseRegistry();

export function formatLeaseRejectMessage(relPath: string, holder: WriteLeaseHolder): string {
  return [
    `[Harness / Write Lease] \`${relPath}\` is being modified by sub-agent "${holder.description}".`,
    'Do not modify this file. If you really need a change there, describe the exact change in your final report instead.',
  ].join('\n');
}
