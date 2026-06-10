/**
 * 记录用户最近工作的会话，供冷启动 / 页面刷新时恢复选中项。
 * 优先级高于 index.json 的 updatedAt（新建会话 B 可能更新更晚，但用户仍在 A 上工作）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import '../cli/paths.js';

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR!);
const LAST_ACTIVE_FILE = path.join(SESSIONS_DIR, 'last-active.json');
const DEFAULT_SESSION_ID = 'default';

export interface SessionIndexEntry {
  id: string;
  updatedAt: number;
}

export interface BootstrapSessionHints {
  getRuntimeActiveId?: () => string;
  getProcessingSessionIds?: () => string[];
}

let bootstrapHints: BootstrapSessionHints = {};

export function registerBootstrapSessionHints(hints: BootstrapSessionHints): void {
  bootstrapHints = { ...bootstrapHints, ...hints };
}

function pickValidInIndex(
  candidate: string | undefined,
  index: SessionIndexEntry[],
): string | undefined {
  if (!candidate) return undefined;
  return index.some((s) => s.id === candidate) ? candidate : undefined;
}

export async function readLastActiveSessionId(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(LAST_ACTIVE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { sessionId?: string };
    if (typeof parsed.sessionId === 'string' && parsed.sessionId) {
      return parsed.sessionId;
    }
  } catch { /* missing or invalid */ }
  return undefined;
}

export async function persistLastActiveSessionId(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.writeFile(
      LAST_ACTIVE_FILE,
      JSON.stringify({ sessionId, savedAt: Date.now() }, null, 2),
      'utf-8',
    );
  } catch (err) {
    console.warn('[last-active-session] persist failed:', err);
  }
}

/** 解析初始活跃会话：运行中 > 内存活跃 > 持久化最近工作 > updatedAt 最近。 */
export async function resolveBootstrapActiveSessionId(
  index: SessionIndexEntry[],
): Promise<string> {
  if (index.length === 0) return DEFAULT_SESSION_ID;

  const fromRuntime = pickValidInIndex(bootstrapHints.getRuntimeActiveId?.(), index);
  if (fromRuntime) return fromRuntime;

  const processing = bootstrapHints.getProcessingSessionIds?.() ?? [];
  for (const sid of processing) {
    const valid = pickValidInIndex(sid, index);
    if (valid) return valid;
  }

  const fromPersisted = pickValidInIndex(await readLastActiveSessionId(), index);
  if (fromPersisted) return fromPersisted;

  const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0]?.id ?? DEFAULT_SESSION_ID;
}
