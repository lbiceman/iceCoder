/**
 * 会话侧栏标题：由用户首条提示词截取生成。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import '../cli/paths.js';
import {
  readSessionIndex,
  writeSessionIndex,
  withSessionIndexLock,
  type SessionMeta,
} from './session-index-store.js';
import {
  deriveSessionTitleFromPrompt,
  isPlaceholderSessionTitle,
  normalizeSessionTitleSource,
} from './session-title-text.js';

export type { SessionMeta };
export {
  SESSION_TITLE_MAX_LEN,
  PLACEHOLDER_SESSION_TITLES,
  deriveSessionTitleFromPrompt,
  isPlaceholderSessionTitle,
} from './session-title-text.js';

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR!);

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

/**
 * 列表加载时：占位标题且已有用户消息 → 用首条提示词回填（兼容旧数据）。
 */
export async function backfillPlaceholderSessionTitles(
  index: SessionMeta[],
): Promise<SessionMeta[]> {
  return withSessionIndexLock(async () => {
    const current = await readSessionIndex();
    const working = current.length > 0 ? current : index;
    let changed = false;
    for (const entry of working) {
      if (!isPlaceholderSessionTitle(entry.title)) continue;
      const first = await readFirstUserMessageContent(entry.id);
      if (!first) continue;
      entry.title = deriveSessionTitleFromPrompt(first);
      entry.updatedAt = Date.now();
      changed = true;
    }
    if (changed) await writeSessionIndex(working);
    return working;
  });
}

/**
 * 标题仍是占位时，用本会话第一条有文字的用户消息生成标题。
 * 只发图片、正文为空时不改标题；之后第一条文字才会替换。
 * @returns 新标题；未更新则 null
 */
export async function applyFirstPromptSessionTitle(
  sessionId: string,
  prompt: string,
): Promise<string | null> {
  return withSessionIndexLock(async () => {
    const index = await readSessionIndex();
    const entry = index.find((s) => s.id === sessionId);
    if (!entry || !isPlaceholderSessionTitle(entry.title)) return null;

    const persisted = await readFirstUserMessageContent(sessionId);
    const source = (persisted && persisted.trim()) ? persisted : prompt;
    if (!normalizeSessionTitleSource(source)) return null;

    const title = deriveSessionTitleFromPrompt(source);
    if (!title || isPlaceholderSessionTitle(title)) return null;
    entry.title = title;
    entry.updatedAt = Date.now();
    await writeSessionIndex(index);
    return title;
  });
}

export interface DeletedMessageSessionMetadata {
  deletedPrompt: string;
  firstRemainingPrompt: string | null;
  remainingUserCount: number;
}

/**
 * 删除用户消息后同步侧栏元数据；仅当标题仍等于被删首条提示词生成的自动标题时才重算标题。
 */
export async function updateSessionMetadataAfterMessageDelete(
  sessionId: string,
  metadata: DeletedMessageSessionMetadata,
): Promise<string | null> {
  return withSessionIndexLock(async () => {
    const index = await readSessionIndex();
    const entry = index.find((session) => session.id === sessionId);
    if (!entry) return null;

    entry.messageCount = metadata.remainingUserCount;
    entry.updatedAt = Date.now();

    let updatedTitle: string | null = null;
    if (
      metadata.deletedPrompt.trim()
      && entry.title === deriveSessionTitleFromPrompt(metadata.deletedPrompt)
    ) {
      updatedTitle = metadata.firstRemainingPrompt?.trim()
        ? deriveSessionTitleFromPrompt(metadata.firstRemainingPrompt)
        : (sessionId === 'default' ? '默认会话' : '新会话');
      entry.title = updatedTitle;
    }

    await writeSessionIndex(index);
    return updatedTitle;
  });
}
