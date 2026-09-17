import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 会话目录下完整工具输出落盘路径（不写入用户仓库）。 */
export function toolOutputSpillFile(
  sessionDir: string,
  sessionId: string,
  toolCallId: string,
): string {
  const safeId = toolCallId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'tool';
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'session';
  return path.join(sessionDir, 'tool-output', safeSession, `${safeId}.log`);
}

/** 把截断前的完整 tool 输出写入会话目录，失败时返回 null。 */
export async function spillToolOutputToSession(opts: {
  sessionDir: string;
  sessionId: string;
  toolCallId: string;
  content: string;
}): Promise<string | null> {
  const file = toolOutputSpillFile(opts.sessionDir, opts.sessionId, opts.toolCallId);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, opts.content, 'utf8');
    return file;
  } catch {
    return null;
  }
}
