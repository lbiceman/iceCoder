/**
 * 会话修改列表：只读 checkpoint 索引里的 sessionTouchedPaths。
 * 操作类型仅用 session 工具历史做展示标注，不另存一份清单。
 */

import type { UiChatMessage } from '../types/intent-checkpoint.js';

export interface CheckpointChangedFile {
  path: string;
  op: string;
  ts: number;
}

const WRITE_TOOLS: Record<string, true> = {
  write_file: true,
  append_file: true,
  edit_file: true,
  patch_file: true,
  batch_edit_file: true,
  fs_operation: true,
  apply_patch: true,
  undo_edit: true,
  create_file: true,
  multi_edit: true,
};

const READ_ONLY_TOOLS: Record<string, true> = {
  read_file: true,
  file_info: true,
  notebook_read: true,
};

export function normalizeSessionTouchedPath(p: string): string {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

function writeOpLabel(toolName: string): string {
  if (toolName === 'write_file' || toolName === 'create_file') return '新建';
  if (toolName === 'undo_edit') return '撤销';
  return '修改';
}

function isLikelyPath(text: string): boolean {
  if (!text || text.length > 400) return false;
  if (text.startsWith('{') || text.startsWith('[')) return false;
  return text !== '.' && text !== '..';
}

interface TraceMeta {
  op?: string;
  ts: number;
  write: boolean;
  read: boolean;
}

function collectTraceMeta(uiMessages: UiChatMessage[]): Map<string, TraceMeta> {
  const meta = new Map<string, TraceMeta>();
  for (const msg of uiMessages) {
    if (!msg || msg.role !== 'tool_trace' || !msg.toolName) continue;
    const status = String(msg.status || '');
    if (status === 'failed' || status === 'error' || status === 'warn') continue;
    const raw = typeof msg.detail === 'string' ? normalizeSessionTouchedPath(msg.detail) : '';
    if (!isLikelyPath(raw)) continue;
    const key = raw.toLowerCase();
    const prev = meta.get(key) || { ts: 0, write: false, read: false };
    const ts = typeof msg.sentAt === 'number' && Number.isFinite(msg.sentAt) ? msg.sentAt : prev.ts;
    if (WRITE_TOOLS[msg.toolName]) {
      prev.write = true;
      prev.op = writeOpLabel(msg.toolName);
      prev.ts = ts;
    } else if (READ_ONLY_TOOLS[msg.toolName]) {
      prev.read = true;
      if (!prev.ts) prev.ts = ts;
    }
    meta.set(key, prev);
  }
  return meta;
}

/** 路径以 checkpoint.sessionTouchedPaths 为准；tool_trace 只补操作类型。 */
export function buildCheckpointChangedFiles(
  sessionTouchedPaths: string[] | undefined,
  uiMessages: UiChatMessage[] = [],
): CheckpointChangedFile[] {
  const meta = collectTraceMeta(uiMessages);
  const seen = new Set<string>();
  const files: CheckpointChangedFile[] = [];
  const paths = Array.isArray(sessionTouchedPaths) ? sessionTouchedPaths : [];

  for (const raw of paths) {
    const path = normalizeSessionTouchedPath(raw);
    if (!isLikelyPath(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    const info = meta.get(key);
    if (info && info.read && !info.write) continue;
    seen.add(key);
    files.push({
      path,
      op: info?.op || '修改',
      ts: info?.ts || 0,
    });
  }

  files.sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.path.localeCompare(b.path));
  return files;
}
