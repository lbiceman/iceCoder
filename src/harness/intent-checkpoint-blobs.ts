/**
 * Intent Checkpoint 内容寻址存储。
 *
 * 归档 JSON 只保留路径、消息、笔记等到 blob 的引用；相同正文在同一会话里只存一份。
 * 读回时展开成原来的 IntentCheckpointArchive，回滚逻辑仍按完整快照工作。
 * 没有 storage 字段的旧归档保持内联，读取时不改写。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';
import type { IntentCheckpointArchive } from '../types/intent-checkpoint.js';
import { INTENT_CHECKPOINT_VERSION } from '../types/intent-checkpoint.js';

export const INTENT_CHECKPOINT_BLOB_STORAGE = 'blobs-v1' as const;

const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

export class IntentCheckpointCorruptError extends Error {
  readonly code = 'INTENT_CHECKPOINT_CORRUPT';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IntentCheckpointCorruptError';
  }
}

interface StoredBlobIntentCheckpoint {
  version: typeof INTENT_CHECKPOINT_VERSION;
  storage: typeof INTENT_CHECKPOINT_BLOB_STORAGE;
  messageId: string;
  sessionId: string;
  createdAt: string;
  userMessageTime: number | null;
  projectCheckpointRef?: string | null;
  combinedCheckpoint?: IntentCheckpointArchive['combinedCheckpoint'];
  workspace: IntentCheckpointArchive['workspace'];
  workspaceRoot: string;
  workspaceFileRefs: Record<string, string | null>;
  trackedPaths: string[];
  structuredMessageRefs: string[];
  uiMessageRefs: string[];
  sessionNotesRef?: string | null;
  toolTraceDiffsRef?: string | null;
}

export function intentCheckpointBlobsDir(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, sessionId, 'checkpoints', 'blobs');
}

export function hashIntentBlobContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function blobPath(sessionDir: string, sessionId: string, hash: string): string {
  if (!BLOB_HASH_RE.test(hash)) {
    throw new IntentCheckpointCorruptError(`非法检查点 blob 引用: ${JSON.stringify(hash)}`);
  }
  return path.join(intentCheckpointBlobsDir(sessionDir, sessionId), hash);
}

async function putIntentBlob(
  sessionDir: string,
  sessionId: string,
  content: string,
): Promise<string> {
  const hash = hashIntentBlobContent(content);
  const dest = blobPath(sessionDir, sessionId, hash);
  try {
    await fs.access(dest);
    return hash;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  await writeFileAtomic(dest, content);
  return hash;
}

async function readIntentBlob(
  sessionDir: string,
  sessionId: string,
  hash: string,
  label: string,
): Promise<string> {
  const file = blobPath(sessionDir, sessionId, hash);
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new IntentCheckpointCorruptError(
        `检查点缺少 ${label} 的内容（${hash}），已停止使用这份快照。`,
        { cause: err },
      );
    }
    throw err;
  }
  const actual = hashIntentBlobContent(content);
  if (actual !== hash) {
    throw new IntentCheckpointCorruptError(
      `检查点 ${label} 的内容与哈希不一致（${hash}）。`,
    );
  }
  return content;
}

function asHashRef(value: unknown, label: string): string {
  if (typeof value === 'string' && BLOB_HASH_RE.test(value)) return value;
  throw new IntentCheckpointCorruptError(`检查点 ${label} 的内容引用无效。`);
}

function asOptionalHashRef(value: unknown, label: string): string | null {
  if (value === null) return null;
  return asHashRef(value, label);
}

async function putOptionalText(
  sessionDir: string,
  sessionId: string,
  content: string | null,
): Promise<string | null> {
  if (content === null) return null;
  return putIntentBlob(sessionDir, sessionId, content);
}

export async function externalizeIntentCheckpoint(
  sessionDir: string,
  sessionId: string,
  archive: IntentCheckpointArchive,
): Promise<StoredBlobIntentCheckpoint> {
  const workspaceFileRefs: Record<string, string | null> = {};
  for (const [rel, content] of Object.entries(archive.workspaceFiles ?? {})) {
    if (content === null) {
      workspaceFileRefs[rel] = null;
      continue;
    }
    if (typeof content !== 'string') {
      throw new TypeError(`workspaceFiles[${rel}] 不是字符串或 null`);
    }
    workspaceFileRefs[rel] = await putIntentBlob(sessionDir, sessionId, content);
  }

  const structuredMessageRefs: string[] = [];
  for (const message of archive.structuredMessages ?? []) {
    structuredMessageRefs.push(
      await putIntentBlob(sessionDir, sessionId, JSON.stringify(message)),
    );
  }
  const uiMessageRefs: string[] = [];
  for (const message of archive.uiMessages ?? []) {
    uiMessageRefs.push(
      await putIntentBlob(sessionDir, sessionId, JSON.stringify(message)),
    );
  }

  const stored: StoredBlobIntentCheckpoint = {
    version: INTENT_CHECKPOINT_VERSION,
    storage: INTENT_CHECKPOINT_BLOB_STORAGE,
    messageId: archive.messageId,
    sessionId: archive.sessionId,
    createdAt: archive.createdAt,
    userMessageTime: archive.userMessageTime,
    workspace: archive.workspace,
    workspaceRoot: archive.workspaceRoot,
    workspaceFileRefs,
    trackedPaths: [...(archive.trackedPaths ?? [])],
    structuredMessageRefs,
    uiMessageRefs,
  };

  if ('projectCheckpoint' in archive) {
    stored.projectCheckpointRef = archive.projectCheckpoint == null
      ? null
      : await putIntentBlob(sessionDir, sessionId, JSON.stringify(archive.projectCheckpoint));
  }
  if ('combinedCheckpoint' in archive) {
    stored.combinedCheckpoint = archive.combinedCheckpoint;
  }
  if (archive.sessionNotesContent !== undefined) {
    stored.sessionNotesRef = await putOptionalText(sessionDir, sessionId, archive.sessionNotesContent);
  }
  if (archive.toolTraceDiffsRaw !== undefined) {
    stored.toolTraceDiffsRef = await putOptionalText(sessionDir, sessionId, archive.toolTraceDiffsRaw);
  }
  return stored;
}

export async function materializeIntentCheckpoint(
  sessionDir: string,
  sessionId: string,
  parsed: unknown,
): Promise<IntentCheckpointArchive> {
  if (!isPlainObject(parsed)) {
    throw new IntentCheckpointCorruptError('检查点归档不是对象。');
  }
  if (parsed.storage == null) {
    return parsed as unknown as IntentCheckpointArchive;
  }
  if (parsed.storage !== INTENT_CHECKPOINT_BLOB_STORAGE) {
    throw new IntentCheckpointCorruptError(
      `未知的检查点存储格式: ${String(parsed.storage)}`,
    );
  }
  const messageId = parsed.messageId;
  const storedSessionId = parsed.sessionId;
  const createdAt = parsed.createdAt;
  const workspaceRoot = parsed.workspaceRoot;
  const userMessageTime = parsed.userMessageTime;
  const workspace = parsed.workspace;
  const trackedPaths = parsed.trackedPaths;
  const workspaceFileRefs = parsed.workspaceFileRefs;
  const structuredMessageRefs = parsed.structuredMessageRefs;
  const uiMessageRefs = parsed.uiMessageRefs;
  if (typeof messageId !== 'string'
    || typeof storedSessionId !== 'string'
    || typeof createdAt !== 'string'
    || typeof workspaceRoot !== 'string'
    || !isPlainObject(workspace)
    || !Array.isArray(trackedPaths)
    || (userMessageTime !== null && typeof userMessageTime !== 'number')) {
    throw new IntentCheckpointCorruptError('检查点归档缺少必要字段。');
  }
  const createdAtText: string = createdAt;
  const messageTime: number | null = userMessageTime;
  if (!isPlainObject(workspaceFileRefs)
    || !Array.isArray(structuredMessageRefs)
    || !Array.isArray(uiMessageRefs)) {
    throw new IntentCheckpointCorruptError('检查点内容引用不完整。');
  }

  const workspaceFiles: Record<string, string | null> = {};
  for (const [rel, ref] of Object.entries(workspaceFileRefs)) {
    const hash = asOptionalHashRef(ref, rel);
    workspaceFiles[rel] = hash === null
      ? null
      : await readIntentBlob(sessionDir, sessionId, hash, rel);
  }

  const structuredMessages: IntentCheckpointArchive['structuredMessages'] = [];
  for (let i = 0; i < structuredMessageRefs.length; i++) {
    const raw = await readIntentBlob(
      sessionDir,
      sessionId,
      asHashRef(structuredMessageRefs[i], `structuredMessages[${i}]`),
      `structuredMessages[${i}]`,
    );
    structuredMessages.push(JSON.parse(raw) as IntentCheckpointArchive['structuredMessages'][number]);
  }
  const uiMessages: IntentCheckpointArchive['uiMessages'] = [];
  for (let i = 0; i < uiMessageRefs.length; i++) {
    const raw = await readIntentBlob(
      sessionDir,
      sessionId,
      asHashRef(uiMessageRefs[i], `uiMessages[${i}]`),
      `uiMessages[${i}]`,
    );
    uiMessages.push(JSON.parse(raw) as IntentCheckpointArchive['uiMessages'][number]);
  }

  const archive: IntentCheckpointArchive = {
    version: INTENT_CHECKPOINT_VERSION,
    messageId,
    sessionId: storedSessionId,
    createdAt: createdAtText,
    userMessageTime: messageTime,
    workspace: workspace as unknown as IntentCheckpointArchive['workspace'],
    workspaceRoot,
    workspaceFiles,
    trackedPaths: trackedPaths.map((entry) => {
      if (typeof entry !== 'string') {
        throw new IntentCheckpointCorruptError('检查点 trackedPaths 含有非字符串。');
      }
      return entry;
    }),
    structuredMessages,
    uiMessages,
  };

  if ('projectCheckpointRef' in parsed) {
    const hash = asOptionalHashRef(parsed.projectCheckpointRef, 'projectCheckpoint');
    archive.projectCheckpoint = hash === null
      ? null
      : JSON.parse(await readIntentBlob(sessionDir, sessionId, hash, 'projectCheckpoint'));
  }
  if ('combinedCheckpoint' in parsed) {
    archive.combinedCheckpoint = parsed.combinedCheckpoint as IntentCheckpointArchive['combinedCheckpoint'];
  }
  if ('sessionNotesRef' in parsed) {
    const hash = asOptionalHashRef(parsed.sessionNotesRef, 'sessionNotes');
    archive.sessionNotesContent = hash === null
      ? null
      : await readIntentBlob(sessionDir, sessionId, hash, 'sessionNotes');
  }
  if ('toolTraceDiffsRef' in parsed) {
    const hash = asOptionalHashRef(parsed.toolTraceDiffsRef, 'toolTraceDiffs');
    archive.toolTraceDiffsRaw = hash === null
      ? null
      : await readIntentBlob(sessionDir, sessionId, hash, 'toolTraceDiffs');
  }
  return archive;
}

/** 当时不存在的路径。无法识别格式时返回 null，调用方应中止回滚。 */
export function absentWorkspacePathsFromArchive(parsed: unknown): string[] | null {
  if (!isPlainObject(parsed)) return null;
  if (parsed.storage == null) {
    return nullContentPaths(parsed.workspaceFiles);
  }
  if (parsed.storage !== INTENT_CHECKPOINT_BLOB_STORAGE) return null;
  if (!isPlainObject(parsed.workspaceFileRefs)) return null;
  return nullContentPaths(parsed.workspaceFileRefs);
}

function nullContentPaths(files: unknown): string[] {
  if (!isPlainObject(files)) return [];
  const paths: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) paths.push(rel);
  }
  return paths;
}

/** 返回引用集合；归档不可信时返回 null，回收必须整次放弃。 */
function blobRefsFromArchive(parsed: unknown): Set<string> | null {
  if (!isPlainObject(parsed)) return null;
  if (parsed.storage == null) return new Set();
  if (parsed.storage !== INTENT_CHECKPOINT_BLOB_STORAGE) return null;
  if (!isPlainObject(parsed.workspaceFileRefs)
    || !Array.isArray(parsed.structuredMessageRefs)
    || !Array.isArray(parsed.uiMessageRefs)) {
    return null;
  }
  const refs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && BLOB_HASH_RE.test(value)) refs.add(value);
  };
  for (const value of Object.values(parsed.workspaceFileRefs)) add(value);
  for (const value of parsed.structuredMessageRefs) add(value);
  for (const value of parsed.uiMessageRefs) add(value);
  if ('projectCheckpointRef' in parsed) add(parsed.projectCheckpointRef);
  if ('sessionNotesRef' in parsed) add(parsed.sessionNotesRef);
  if ('toolTraceDiffsRef' in parsed) add(parsed.toolTraceDiffsRef);
  return refs;
}

async function collectReferencedBlobHashes(
  sessionDir: string,
  sessionId: string,
): Promise<Set<string> | null> {
  const dir = path.join(sessionDir, sessionId, 'checkpoints');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
  const referenced = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.intent.json') || path.basename(name) !== name) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8'));
    } catch (err) {
      console.warn(
        `[intent-checkpoint] 跳过 blob 回收，归档无法解析: ${name}`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    const refs = blobRefsFromArchive(parsed);
    if (refs === null) {
      console.warn(`[intent-checkpoint] 跳过 blob 回收，归档格式无法识别: ${name}`);
      return null;
    }
    for (const hash of refs) referenced.add(hash);
  }
  return referenced;
}

/** 删掉已经没有任何归档引用的 blob。调用方需持有该会话的 checkpoint 索引锁。 */
export async function sweepUnreferencedIntentBlobs(
  sessionDir: string,
  sessionId: string,
): Promise<void> {
  const dir = intentCheckpointBlobsDir(sessionDir, sessionId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const referenced = await collectReferencedBlobHashes(sessionDir, sessionId);
  if (referenced === null) return;

  await Promise.all(names.map(async (name) => {
    const full = path.join(dir, name);
    if (BLOB_HASH_RE.test(name)) {
      if (referenced.has(name)) return;
    } else if (!name.endsWith('.tmp')) {
      return;
    }
    await fs.unlink(full).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }));
}
