/**
 * 回退快照里的文件内容编码。
 * 快照以字符串落盘（归档 JSON、blob 都是文本），非 UTF-8 文本的文件（图片、Office 文档、GBK 源码）
 * 存成「NUL 开头的标记 + base64」；正常文本不含 NUL，不会与标记混淆。
 */

import { isUtf8 } from 'node:buffer';
import { promises as fs } from 'node:fs';

const BINARY_PREFIX = '\u0000ice-binary:base64:';
const OVERSIZED_PREFIX = '\u0000ice-binary:skipped:';
const REPLACEMENT_CHAR = '\uFFFD';

/** 超过这个大小的二进制文件只记「存在」，回退时保持磁盘现状。 */
export const MAX_SNAPSHOT_BINARY_BYTES = 8 * 1024 * 1024;

export type DecodedSnapshotContent =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; data: Buffer }
  | { kind: 'skip'; reason: string };

export function encodeSnapshotContent(data: Buffer): string {
  if (!data.includes(0) && isUtf8(data)) {
    const text = data.toString('utf-8');
    // 含 U+FFFD 的文本也走 base64：未加标记又含 U+FFFD 的内容一律视为旧版按文本读坏的二进制。
    if (!text.includes(REPLACEMENT_CHAR)) return text;
  }
  if (data.length > MAX_SNAPSHOT_BINARY_BYTES) return `${OVERSIZED_PREFIX}${data.length}`;
  return BINARY_PREFIX + data.toString('base64');
}

export async function readSnapshotFileContent(absPath: string): Promise<string> {
  return encodeSnapshotContent(await fs.readFile(absPath));
}

export function decodeSnapshotContent(content: string): DecodedSnapshotContent {
  if (content.startsWith(BINARY_PREFIX)) {
    return { kind: 'binary', data: Buffer.from(content.slice(BINARY_PREFIX.length), 'base64') };
  }
  if (content.startsWith(OVERSIZED_PREFIX)) {
    const bytes = Number(content.slice(OVERSIZED_PREFIX.length));
    return { kind: 'skip', reason: `二进制文件 ${(bytes / 1024 / 1024).toFixed(1)}MB 超出快照上限，未保存内容` };
  }
  if (content.includes('\u0000') || content.includes(REPLACEMENT_CHAR)) {
    return { kind: 'skip', reason: '旧版快照把二进制内容按文本保存，内容已损坏' };
  }
  return { kind: 'text', text: content };
}
