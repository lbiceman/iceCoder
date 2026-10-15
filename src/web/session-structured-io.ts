/**
 * 多会话结构化消息（.structured.json）磁盘读写。
 * 供 chat-ws 刷盘/加载与单测复用。
 */

import path from 'path';
import type { UnifiedMessage } from '../llm/types.js';
import { enqueueFileWrite, readJsonArrayFile, writeJsonArrayAtomic } from './session-json-file.js';

export function structuredSessionPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.structured.json`);
}

export async function writeStructuredMessagesFile(
  sessionsDir: string,
  sessionId: string,
  messages: UnifiedMessage[],
  options?: { replaceCorrupt?: boolean },
): Promise<void> {
  const file = structuredSessionPath(sessionsDir, sessionId);
  await enqueueFileWrite(file, async () => {
    const outcome = await writeJsonArrayAtomic(file, messages, options);
    if (outcome === 'skipped-corrupt') {
      console.error(`[session-structured] 跳过空覆盖，文件已损坏: ${file}`);
    }
  });
}

export async function readStructuredMessagesFile(
  sessionsDir: string,
  sessionId: string,
): Promise<UnifiedMessage[] | undefined> {
  try {
    const state = await readJsonArrayFile(structuredSessionPath(sessionsDir, sessionId));
    if (state.status === 'ok' && state.value.length > 0) {
      return state.value as UnifiedMessage[];
    }
  } catch { /* 读失败时当作没有历史，不改磁盘 */ }
  return undefined;
}

/**
 * 同步刷盘：取消 pending 定时器后立即写入（switch_session 步骤 1）。
 */
export async function flushStructuredSessionToDisk(
  sessionsDir: string,
  sessionId: string,
  messages: UnifiedMessage[] | undefined,
  cancelPendingTimer?: () => void,
): Promise<void> {
  cancelPendingTimer?.();
  if (!messages || messages.length === 0) return;
  await writeStructuredMessagesFile(sessionsDir, sessionId, messages);
}
