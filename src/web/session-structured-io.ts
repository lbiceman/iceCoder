/**
 * 多会话结构化消息（.structured.json）磁盘读写。
 * 供 chat-ws 刷盘/加载与单测复用。
 */

import { promises as fs } from 'node:fs';
import path from 'path';
import type { UnifiedMessage } from '../llm/types.js';

export function structuredSessionPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.structured.json`);
}

export async function writeStructuredMessagesFile(
  sessionsDir: string,
  sessionId: string,
  messages: UnifiedMessage[],
): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(structuredSessionPath(sessionsDir, sessionId), JSON.stringify(messages), 'utf-8');
}

export async function readStructuredMessagesFile(
  sessionsDir: string,
  sessionId: string,
): Promise<UnifiedMessage[] | undefined> {
  try {
    const data = await fs.readFile(structuredSessionPath(sessionsDir, sessionId), 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as UnifiedMessage[];
    }
  } catch { /* missing or empty */ }
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
