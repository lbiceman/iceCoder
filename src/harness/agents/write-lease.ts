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

function leaseAbsPath(workspaceRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspaceRoot, filePath);
}

function leaseKey(workspaceRoot: string, filePath: string): string {
  const normalized = leaseAbsPath(workspaceRoot, filePath).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 租约表按会话隔离：由该会话的 AgentSpawner 持有，不跨会话共享。 */
export class WriteLeaseRegistry {
  private readonly leases = new Map<string, WriteLeaseHolder & { absPath: string }>();

  acquire(
    workspaceRoot: string,
    filePath: string,
    agent: { agentId: string; description: string },
    now: number = Date.now(),
  ): WriteLeaseAcquireResult {
    const key = leaseKey(workspaceRoot, filePath);
    const existing = this.leases.get(key);
    if (existing && existing.agentId !== agent.agentId) {
      return { ok: false, holder: toHolder(existing) };
    }
    this.leases.set(key, {
      agentId: agent.agentId,
      description: agent.description,
      lastWriteAt: now,
      absPath: leaseAbsPath(workspaceRoot, filePath),
    });
    return { ok: true };
  }

  holderOf(workspaceRoot: string, filePath: string): WriteLeaseHolder | undefined {
    const holder = this.leases.get(leaseKey(workspaceRoot, filePath));
    return holder ? toHolder(holder) : undefined;
  }

  /** 其它 Agent 持有的租约（绝对路径），用于命令前后比对。 */
  leasesHeldByOthers(agentId: string): Array<{ absPath: string; holder: WriteLeaseHolder }> {
    const out: Array<{ absPath: string; holder: WriteLeaseHolder }> = [];
    for (const lease of this.leases.values()) {
      if (lease.agentId !== agentId) out.push({ absPath: lease.absPath, holder: toHolder(lease) });
    }
    return out;
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

function toHolder(lease: WriteLeaseHolder): WriteLeaseHolder {
  return { agentId: lease.agentId, description: lease.description, lastWriteAt: lease.lastWriteAt };
}

export function formatLeaseRejectMessage(relPath: string, holder: WriteLeaseHolder): string {
  return [
    `[Harness / Write Lease] \`${relPath}\` is being modified by sub-agent "${holder.description}".`,
    'Do not modify this file. If you really need a change there, describe the exact change in your final report instead.',
  ].join('\n');
}

export function formatCommandLeaseViolationMessage(
  violations: ReadonlyArray<{ path: string; holder: WriteLeaseHolder }>,
): string {
  return [
    '[Harness / Write Lease] This command modified files that another sub-agent is working on:',
    ...violations.map(v => `- \`${v.path}\` (held by sub-agent "${v.holder.description}")`),
    'Treat this command as failed. Do not run commands that rewrite these files; '
      + 'describe the change they need in your final report instead.',
  ].join('\n');
}
