/**
 * 会话内 read-before-edit：按 sessionId + 工作区根路径作用域。
 * 可用 ICE_READ_BEFORE_EDIT=0 关闭。
 */

import path from 'node:path';

const readsByScope = new Map<string, Set<string>>();
const MAX_READ_SCOPES = 256;

function pruneReadScopes(): void {
  while (readsByScope.size > MAX_READ_SCOPES) {
    const first = readsByScope.keys().next().value;
    if (first === undefined) break;
    readsByScope.delete(first);
  }
}

export function readBeforeEditEnabled(): boolean {
  const v = process.env.ICE_READ_BEFORE_EDIT;
  if (v === '0' || v === 'false') return false;
  return true;
}

function scopeKey(workDir: string, sessionId?: string): string {
  const root = path.resolve(workDir).toLowerCase();
  const sid = (sessionId?.trim() || 'default');
  return `${sid}\0${root}`;
}

/** 工作区内归一化相对路径（用于比对）。 */
export function normalizeWorkRelPath(workDir: string, rawPath: string): string {
  const base = path.resolve(workDir);
  const abs = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(base, rawPath);
  const rel = path.relative(base, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, '/');
  }
  return abs.replace(/\\/g, '/');
}

export function markFileRead(workDir: string, rawPath: string, sessionId?: string): void {
  const key = scopeKey(workDir, sessionId);
  let set = readsByScope.get(key);
  if (!set) {
    set = new Set();
    readsByScope.set(key, set);
  }
  set.add(normalizeWorkRelPath(workDir, rawPath));
  pruneReadScopes();
}

export function hasFileBeenRead(workDir: string, rawPath: string, sessionId?: string): boolean {
  return readsByScope.get(scopeKey(workDir, sessionId))?.has(normalizeWorkRelPath(workDir, rawPath)) ?? false;
}

/** 未读过则返回错误文案；否则 null。 */
export function checkReadBeforeEdit(workDir: string, rawPath: string, sessionId?: string): string | null {
  if (!readBeforeEditEnabled()) return null;
  if (hasFileBeenRead(workDir, rawPath, sessionId)) return null;
  const rel = normalizeWorkRelPath(workDir, rawPath);
  return `read-before-edit: read_file "${rel}" in this session before editing. New files: use write_file instead.`;
}

/** 新 Harness 任务边界：清空该 session + 工作区的已读记录。 */
export function clearReadBeforeEditScope(workDir: string, sessionId?: string): void {
  readsByScope.delete(scopeKey(workDir, sessionId));
}
