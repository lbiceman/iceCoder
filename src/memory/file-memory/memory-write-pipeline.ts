/**
 * 主代理 / 手动 / Web 写记忆文件的统一后处理：秘密扫描 + MEMORY.md 索引维护 + 写盘门控。
 */

import path from 'node:path';
import { DEFAULT_MEMORY_DIR, resolveUserMemoryDir, EXTRACTION_SIGNAL_WORDS } from './memory-config.js';
import { isWithinMemoryDir } from './memory-security.js';
import { scanForSecrets, redactSecrets } from './memory-secret-scanner.js';
import { upsertIndexRow, ensureMemoryIndexBootstrapped } from './memory-index-maintainer.js';
import { getScannerCache } from './memory-scanner-cache.js';
import type { MemoryHeader } from './types.js';

function hasRememberSignal(message: string): boolean {
  const lower = message.toLowerCase();
  return EXTRACTION_SIGNAL_WORDS.some(w => lower.includes(w.toLowerCase()));
}

export type AgentMemoryWriteGuardFn = () => string | null;

let agentMemoryWriteGuard: AgentMemoryWriteGuardFn | null = null;

/** Harness 生命周期内注册：未明确要求 remember 时拒绝主代理写长期记忆 */
export function registerAgentMemoryWriteGuard(guard: AgentMemoryWriteGuardFn | null): void {
  agentMemoryWriteGuard = guard;
}

function memoryRoots(): string[] {
  return [
    path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR),
    path.resolve(resolveUserMemoryDir()),
  ];
}

/** 绝对路径若落在记忆目录内，返回该根目录；否则 null */
export function resolveMemoryRootForPath(absolutePath: string): string | null {
  const normalized = path.resolve(absolutePath);
  for (const root of memoryRoots()) {
    if (isWithinMemoryDir(normalized, root)) return root;
  }
  return null;
}

/**
 * 主代理 write/edit/append 写记忆目录前的硬门控（REQ-E6）。
 * @returns 错误信息；null 表示允许
 */
export function assertAgentMemoryWriteAllowed(absolutePath: string): string | null {
  if (!resolveMemoryRootForPath(absolutePath)) return null;
  if (!agentMemoryWriteGuard) return null;
  return agentMemoryWriteGuard();
}

/** 写盘前秘密扫描（与 Extract 一致） */
export function sanitizeMemoryContentBeforeWrite(content: string): { content: string; redacted: boolean } {
  const secrets = scanForSecrets(content);
  if (secrets.length === 0) {
    return { content, redacted: false };
  }
  console.warn(
    `[memory-write] Secret detected (${secrets.map(s => s.label).join(', ')}). Redacting.`,
  );
  return { content: redactSecrets(content), redacted: true };
}

function parseFrontmatterField(content: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'im');
  const m = content.match(re);
  return m?.[1]?.trim() ?? '';
}

/** 记忆 .md 写入完成后：bootstrap 索引 + upsert 行 */
export async function afterMemoryMarkdownWritten(absolutePath: string, fileContent: string): Promise<void> {
  const root = resolveMemoryRootForPath(absolutePath);
  if (!root) return;

  const filename = path.basename(absolutePath);
  if (filename === 'MEMORY.md' || !filename.endsWith('.md')) return;

  await ensureMemoryIndexBootstrapped(root);

  const description = parseFrontmatterField(fileContent, 'description')
    || parseFrontmatterField(fileContent, 'name')
    || filename.replace(/\.md$/i, '');
  const type = (parseFrontmatterField(fileContent, 'type') || 'project') as MemoryHeader['type'];

  await upsertIndexRow(root, { filename, description, type });
  getScannerCache().invalidate(root);
}

/** Harness 默认门控：当前用户消息须含 remember 类信号词 */
export function createRememberSignalWriteGuard(getUserMessage: () => string): AgentMemoryWriteGuardFn {
  return () => {
    const msg = getUserMessage().trim();
    if (!msg) {
      return 'Long-term memory writes require the user to explicitly ask you to remember something in the current turn.';
    }
    if (hasRememberSignal(msg)) return null;
    return 'Long-term memory writes are only allowed when the user explicitly asks you to remember something (e.g. 记住 / remember). Use session-notes for task progress.';
  };
}
