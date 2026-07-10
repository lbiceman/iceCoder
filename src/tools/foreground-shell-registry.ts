/**
 * 跟踪 run_command 前台 spawn，供用户 Stop / 应用退出时终止孤儿进程。
 */

import type { ChildProcess } from 'node:child_process';
import { killShellProcessTree } from './shell-process-kill.js';

interface ForegroundEntry {
  sessionId: string;
  child: ChildProcess;
  rootPid: number;
  commandPreview: string;
}

const entries = new Map<number, ForegroundEntry>();

function commandPreview(command: string): string {
  const trimmed = command.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/** 登记前台 shell 子进程（close/error 后自动移除）。 */
export function registerForegroundShell(
  sessionId: string,
  child: ChildProcess,
  command: string,
): void {
  const rootPid = child.pid;
  if (!rootPid) return;

  entries.set(rootPid, {
    sessionId,
    child,
    rootPid,
    commandPreview: commandPreview(command),
  });

  const cleanup = () => {
    entries.delete(rootPid);
  };
  child.once('close', cleanup);
  child.once('error', cleanup);
}

/** 前台进程转交后台 manager 时移除登记，避免重复跟踪。 */
export function unregisterForegroundShell(child: ChildProcess): void {
  const rootPid = child.pid;
  if (!rootPid) return;
  entries.delete(rootPid);
}

function killEntry(entry: ForegroundEntry, reason: string): void {
  console.log(
    `[fg-shell] ${reason} session=${entry.sessionId} pid=${entry.rootPid} command="${entry.commandPreview}"`,
  );
  killShellProcessTree(entry.rootPid, entry.child);
  entries.delete(entry.rootPid);
}

/** 终止指定会话的全部前台 shell。 */
export function killForegroundShellsForSession(sessionId: string): number {
  let count = 0;
  for (const entry of [...entries.values()]) {
    if (entry.sessionId !== sessionId) continue;
    killEntry(entry, '用户停止/会话中断');
    count++;
  }
  return count;
}

/** 终止全部前台 shell（应用退出时调用）。 */
export function killAllForegroundShells(): number {
  let count = 0;
  for (const entry of [...entries.values()]) {
    killEntry(entry, '应用退出');
    count++;
  }
  return count;
}

/** @internal 测试重置 */
export function __resetForegroundShellRegistry(): void {
  entries.clear();
}
