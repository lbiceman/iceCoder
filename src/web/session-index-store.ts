/**
 * 会话 index.json 的读写与磁盘对账。
 *
 * 侧栏只展示 index 里的条目。Windows 上 `writeFile` 会先截断文件，
 * 并发读可能解析失败得到 `[]`，再整表写回就会把历史从列表里抹掉
 *（磁盘上的 `{id}.json` 仍在）。因此：写必须原子；读-改-写必须串行；
 * 加载时把磁盘上已有会话补回 index。
 */

import { promises as fs } from 'node:fs';
import path from 'path';
import '../cli/paths.js';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';
import { isSafeSessionId } from './session-id-guard.js';

export const DEFAULT_SESSION_ID = 'default';
const TITLE_MAX_LEN = 20;
const PLACEHOLDER_TITLES = new Set(['新会话', '默认会话', '未命名']);

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface ChatMessageLike {
  role?: string;
  content?: string;
  sentAt?: number;
  completedAt?: number;
}

let indexLock: Promise<void> = Promise.resolve();

function sessionsDir(): string {
  return path.resolve(process.env.ICE_SESSIONS_DIR!);
}

function indexFile(): string {
  return path.join(sessionsDir(), 'index.json');
}

export function withSessionIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = indexLock;
  let release!: () => void;
  indexLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev.then(fn, fn).finally(() => {
    release();
  });
}

function isIndexNoiseFile(id: string): boolean {
  if (id === 'index' || id === 'last-active') return true;
  if (id.startsWith('also-') || id.startsWith('inbound-')) return true;
  return false;
}

/** `{id}.json` 才是会话消息文件；sidecar（structured / checkpoint / …）不含在内。 */
export function sessionIdFromMessageFileName(name: string): string | null {
  if (!name.endsWith('.json')) return null;
  const id = name.slice(0, -'.json'.length);
  if (!id || isIndexNoiseFile(id) || !isSafeSessionId(id)) return null;
  return id;
}

function deriveTitleFromPrompt(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim();
  if (!t) return '未命名';
  if (t.length <= TITLE_MAX_LEN) return t;
  return `${t.slice(0, TITLE_MAX_LEN - 1)}…`;
}

function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title);
}

function firstUserPrompt(msgs: ChatMessageLike[]): string | null {
  for (const m of msgs) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

async function readSessionMessages(sessionId: string): Promise<ChatMessageLike[] | null> {
  const file = path.join(sessionsDir(), `${sessionId}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as ChatMessageLike[] : null;
  } catch {
    return null;
  }
}

async function metaFromSessionFile(sessionId: string): Promise<SessionMeta | null> {
  const file = path.join(sessionsDir(), `${sessionId}.json`);
  const msgs = await readSessionMessages(sessionId);
  if (!msgs) return null;
  let createdAt = Date.now();
  let updatedAt = createdAt;
  try {
    const st = await fs.stat(file);
    createdAt = Math.round(st.birthtimeMs || st.ctimeMs || st.mtimeMs || createdAt);
    updatedAt = Math.round(st.mtimeMs || updatedAt);
  } catch {
    /* keep Date.now() */
  }
  const firstSent = msgs.find((m) => typeof m.sentAt === 'number')?.sentAt;
  const lastStamp = [...msgs].reverse().find((m) =>
    typeof m.completedAt === 'number' || typeof m.sentAt === 'number',
  );
  if (typeof firstSent === 'number') createdAt = firstSent;
  if (lastStamp) {
    const stamp = lastStamp.completedAt ?? lastStamp.sentAt;
    if (typeof stamp === 'number') updatedAt = stamp;
  }
  const prompt = firstUserPrompt(msgs);
  const title = prompt
    ? deriveTitleFromPrompt(prompt)
    : (sessionId === DEFAULT_SESSION_ID ? '默认会话' : '新会话');
  return {
    id: sessionId,
    title,
    createdAt,
    updatedAt,
    messageCount: msgs.length,
  };
}

export async function readSessionIndex(): Promise<SessionMeta[]> {
  try {
    const data = await fs.readFile(indexFile(), 'utf-8');
    if (!data.trim()) return [];
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is SessionMeta =>
      !!row && typeof row === 'object' && typeof (row as SessionMeta).id === 'string',
    );
  } catch {
    return [];
  }
}

export async function writeSessionIndex(index: SessionMeta[]): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
  await writeFileAtomic(indexFile(), `${JSON.stringify(index, null, 2)}\n`);
}

async function listSessionIdsOnDisk(): Promise<string[]> {
  const names = await fs.readdir(sessionsDir()).catch((): string[] => []);
  const ids: string[] = [];
  for (const name of names) {
    const id = sessionIdFromMessageFileName(name);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * 把磁盘上有 `{id}.json`、但 index 里没有的会话补回去。
 * 不删除 index 中尚无文件的条目（POST 可能先写 index 再写 json）。
 */
export async function reconcileSessionIndex(
  index: SessionMeta[],
): Promise<{ index: SessionMeta[]; recovered: number }> {
  const diskIds = await listSessionIdsOnDisk();
  const known = new Set(index.map((s) => s.id));
  const recovered: SessionMeta[] = [];
  for (const id of diskIds) {
    if (known.has(id)) continue;
    const meta = await metaFromSessionFile(id);
    if (!meta) continue;
    recovered.push(meta);
    known.add(id);
  }
  if (recovered.length === 0) return { index, recovered: 0 };
  recovered.sort((a, b) => b.updatedAt - a.updatedAt);
  const next = [...index, ...recovered];
  console.log(`[sessions] recovered ${recovered.length} session(s) missing from index.json`);
  return { index: next, recovered: recovered.length };
}

function emptyDefaultMeta(): SessionMeta {
  const now = Date.now();
  return {
    id: DEFAULT_SESSION_ID,
    title: '默认会话',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
}

async function loadSessionIndexUnlocked(): Promise<SessionMeta[]> {
  let index = await readSessionIndex();
  const reconciled = await reconcileSessionIndex(index);
  index = reconciled.index;
  let dirty = reconciled.recovered > 0;

  if (index.length === 0) {
    const fromDefaultFile = await metaFromSessionFile(DEFAULT_SESSION_ID);
    if (fromDefaultFile) {
      index = [fromDefaultFile];
    } else {
      const fallback = emptyDefaultMeta();
      const defaultFile = path.join(sessionsDir(), `${DEFAULT_SESSION_ID}.json`);
      try {
        const data = await fs.readFile(defaultFile, 'utf-8');
        const msgs = JSON.parse(data) as unknown;
        if (Array.isArray(msgs)) fallback.messageCount = msgs.length;
        const prompt = firstUserPrompt(msgs as ChatMessageLike[]);
        if (prompt) fallback.title = deriveTitleFromPrompt(prompt);
      } catch { /* no default file */ }
      index = [fallback];
    }
    dirty = true;
  }

  if (dirty) await writeSessionIndex(index);
  return index;
}

/** 对账 + 空 index 时引导 default。所有列表/创建/删除入口应走这里或 mutate。 */
export async function loadSessionIndex(): Promise<SessionMeta[]> {
  return withSessionIndexLock(() => loadSessionIndexUnlocked());
}

export async function mutateSessionIndex(
  mutator: (index: SessionMeta[]) => SessionMeta[] | Promise<SessionMeta[]>,
): Promise<SessionMeta[]> {
  return withSessionIndexLock(async () => {
    let index = await loadSessionIndexUnlocked();
    index = await mutator(index);
    await writeSessionIndex(index);
    return index;
  });
}

