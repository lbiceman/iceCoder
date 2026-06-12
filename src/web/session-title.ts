/**
 * 会话侧栏标题：由用户首条提示词截取生成。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import '../cli/paths.js';

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR!);
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

export const SESSION_TITLE_MAX_LEN = 20;

/** 仍为占位标题、可被首条提示词覆盖 */
export const PLACEHOLDER_SESSION_TITLES = new Set(['新会话', '默认会话', '未命名']);

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

async function readSessionIndex(): Promise<SessionMeta[]> {
  try {
    const data = await fs.readFile(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed as SessionMeta[];
  } catch { /* missing or invalid */ }
  return [];
}

async function writeSessionIndex(index: SessionMeta[]): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

/** 将首条用户提示词截取为侧栏显示标题 */
export function deriveSessionTitleFromPrompt(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim();
  if (!t) return '未命名';
  if (t.length <= SESSION_TITLE_MAX_LEN) return t;
  return `${t.slice(0, SESSION_TITLE_MAX_LEN - 1)}…`;
}

export function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_SESSION_TITLES.has(title);
}

async function readFirstUserMessageContent(sessionId: string): Promise<string | null> {
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const msgs = JSON.parse(raw) as { role?: string; content?: string }[];
    if (!Array.isArray(msgs)) return null;
    for (const m of msgs) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        return m.content;
      }
    }
  } catch { /* no file */ }
  return null;
}

async function countPersistedUserMessages(sessionId: string): Promise<number> {
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const msgs = JSON.parse(raw) as { role?: string }[];
    if (!Array.isArray(msgs)) return 0;
    return msgs.filter((m) => m.role === 'user').length;
  } catch {
    return 0;
  }
}

/**
 * 列表加载时：占位标题且已有用户消息 → 用首条提示词回填（兼容旧数据）。
 */
export async function backfillPlaceholderSessionTitles(
  index: SessionMeta[],
): Promise<SessionMeta[]> {
  let changed = false;
  for (const entry of index) {
    if (!isPlaceholderSessionTitle(entry.title)) continue;
    const first = await readFirstUserMessageContent(entry.id);
    if (!first) continue;
    entry.title = deriveSessionTitleFromPrompt(first);
    entry.updatedAt = Date.now();
    changed = true;
  }
  if (changed) await writeSessionIndex(index);
  return index;
}

/**
 * 首条用户消息持久化后：若标题仍为占位，则写入截取后的提示词。
 * @returns 新标题；未更新则 null
 */
export async function applyFirstPromptSessionTitle(
  sessionId: string,
  prompt: string,
): Promise<string | null> {
  const index = await readSessionIndex();
  const entry = index.find((s) => s.id === sessionId);
  if (!entry || !isPlaceholderSessionTitle(entry.title)) return null;

  const userCount = await countPersistedUserMessages(sessionId);
  if (userCount !== 1) return null;

  const title = deriveSessionTitleFromPrompt(prompt);
  entry.title = title;
  entry.updatedAt = Date.now();
  entry.messageCount = Math.max(entry.messageCount, userCount);
  await writeSessionIndex(index);
  return title;
}
