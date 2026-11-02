/**
 * Intent Checkpoint 内容寻址存储。
 *
 * 归档 JSON 只保留引用，正文放在 `{sessionId}/checkpoints/blobs/`，同一会话里相同内容只存一份。
 * - blobs-v2（当前写入格式）：文件清单按目录拆成树；消息逐条一个 blob，超长字符串（内联图片、
 *   大段输出）再单独成 blob；projectCheckpoint 里的对话消息复用同一批消息 blob。
 * - blobs-v1：文件清单与消息引用平铺在归档里，只读兼容。
 * - 没有 storage 字段的旧归档保持内联，只读兼容，读取时不改写。
 * 读回时展开成 IntentCheckpointArchive，回滚逻辑仍按完整快照工作。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';
import type { IntentCheckpointArchive, UiChatMessage } from '../types/intent-checkpoint.js';
import { INTENT_CHECKPOINT_VERSION } from '../types/intent-checkpoint.js';
import {
  asHashRef,
  asOptionalHashRef,
  BLOB_HASH_RE,
  IntentBlobStore,
  IntentCheckpointCorruptError,
  intentCheckpointBlobsDir,
  setOwn,
} from './intent-checkpoint-blob-io.js';
import {
  collectWorkspaceTreeRefs,
  putWorkspaceTree,
  readWorkspaceTree,
} from './intent-checkpoint-workspace-tree.js';

export {
  hashIntentBlobContent,
  IntentBlobStore,
  IntentCheckpointCorruptError,
  intentCheckpointBlobsDir,
} from './intent-checkpoint-blob-io.js';

export const INTENT_CHECKPOINT_BLOB_STORAGE = 'blobs-v1' as const;
export const INTENT_CHECKPOINT_BLOB_STORAGE_V2 = 'blobs-v2' as const;

/** 不短于这个长度的字符串单独成 blob：同一张内联图片出现在多条消息里也只存一份。 */
const HOLE_MIN_CHARS = 16 * 1024;
/** 含孤立代理项的字符串写成 UTF-8 后读不回原样，不能拆出去。 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type JsonPath = Array<string | number>;
type JsonHole = [path: JsonPath, hash: string];
/** 没有超长字符串时就是正文哈希；否则正文对应位置留空串，原文按 h 里的路径另存。 */
type StoredJsonRef = string | { b: string; h: JsonHole[] };

interface StoredProjectCheckpointRef {
  b: string;
  h?: JsonHole[];
  /** conversation.messages 逐条引用，与 structuredMessageRefs 共用消息 blob */
  m?: StoredJsonRef[];
}

export interface StoredIntentCheckpointV2 {
  version: typeof INTENT_CHECKPOINT_VERSION;
  storage: typeof INTENT_CHECKPOINT_BLOB_STORAGE_V2;
  messageId: string;
  sessionId: string;
  createdAt: string;
  userMessageTime: number | null;
  workspace: IntentCheckpointArchive['workspace'];
  workspaceRoot: string;
  workspaceTreeRef: string | null;
  /** 放不进目录树的路径（空段、`.`、`..`） */
  looseFileRefs?: Record<string, string | null>;
  /** 跟踪了但不在文件清单里的路径，例如工作区外的路径 */
  trackedPathsExtra?: string[];
  /** 在文件清单里但没有跟踪的路径 */
  trackedPathsOmit?: string[];
  structuredMessageRefs: StoredJsonRef[];
  uiMessageRefs: StoredJsonRef[];
  projectCheckpointRef?: StoredProjectCheckpointRef | null;
  combinedCheckpoint?: IntentCheckpointArchive['combinedCheckpoint'];
  sessionNotesRef?: string | null;
  toolTraceDiffsRef?: string | null;
}

export type IntentFileRef = { hash: string } | { inline: string };

/** 不展开正文的归档视图，供只需要路径清单的调用方使用。 */
export interface IntentCheckpointHead {
  messageId: string;
  sessionId: string;
  createdAt: string;
  userMessageTime: number | null;
  workspaceRoot: string;
  workspace: IntentCheckpointArchive['workspace'];
  trackedPaths: string[];
  /** 相对路径 → 内容引用；null 表示该路径当时不存在 */
  files: Record<string, IntentFileRef | null>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isStoredIntentCheckpointV2(value: unknown): value is StoredIntentCheckpointV2 {
  return isPlainObject(value) && value.storage === INTENT_CHECKPOINT_BLOB_STORAGE_V2;
}

async function blankLargeStrings(
  store: IntentBlobStore,
  value: unknown,
  at: JsonPath,
  holes: JsonHole[],
): Promise<unknown> {
  if (typeof value === 'string') {
    if (value.length < HOLE_MIN_CHARS || LONE_SURROGATE_RE.test(value)) return value;
    holes.push([[...at], await store.put(value)]);
    return '';
  }
  if (value === null || typeof value !== 'object') return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    return blankLargeStrings(store, toJSON.call(value), at, holes);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      at.push(i);
      out[i] = await blankLargeStrings(store, value[i], at, holes);
      at.pop();
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    at.push(key);
    setOwn(out, key, await blankLargeStrings(store, child, at, holes));
    at.pop();
  }
  return out;
}

async function putJsonValue(store: IntentBlobStore, value: unknown): Promise<StoredJsonRef> {
  const body = JSON.stringify(value);
  if (body === undefined) throw new TypeError('检查点内容无法序列化为 JSON');
  if (body.length < HOLE_MIN_CHARS) return store.put(body);
  const holes: JsonHole[] = [];
  const blanked = await blankLargeStrings(store, value, [], holes);
  if (holes.length === 0) return store.put(body);
  return { b: await store.put(JSON.stringify(blanked)), h: holes };
}

async function putJsonList(store: IntentBlobStore, values: readonly unknown[]): Promise<StoredJsonRef[]> {
  const refs: StoredJsonRef[] = [];
  for (const value of values) refs.push(await putJsonValue(store, value));
  return refs;
}

function parseHoles(value: unknown, label: string): JsonHole[] {
  if (!Array.isArray(value)) throw new IntentCheckpointCorruptError(`检查点 ${label} 的外置字段清单无效。`);
  return value.map((hole) => {
    if (!Array.isArray(hole) || hole.length !== 2 || !Array.isArray(hole[0])
      || !hole[0].every((key: unknown) => typeof key === 'string'
        || (typeof key === 'number' && Number.isInteger(key) && key >= 0))) {
      throw new IntentCheckpointCorruptError(`检查点 ${label} 的外置字段路径无效。`);
    }
    return [hole[0] as JsonPath, asHashRef(hole[1], label)];
  });
}

function fillHole(root: unknown, at: JsonPath, text: string, label: string): unknown {
  if (at.length === 0) return text;
  const fail = () => new IntentCheckpointCorruptError(`检查点 ${label} 的外置字段位置不存在。`);
  let node: unknown = root;
  for (const key of at.slice(0, -1)) {
    if (Array.isArray(node) && typeof key === 'number' && key < node.length) node = node[key];
    else if (isPlainObject(node) && typeof key === 'string' && Object.hasOwn(node, key)) node = node[key];
    else throw fail();
  }
  const last = at[at.length - 1];
  if (Array.isArray(node) && typeof last === 'number' && last < node.length) node[last] = text;
  else if (isPlainObject(node) && typeof last === 'string' && Object.hasOwn(node, last)) setOwn(node, last, text);
  else throw fail();
  return root;
}

async function readJsonValue(store: IntentBlobStore, ref: unknown, label: string): Promise<unknown> {
  if (typeof ref === 'string') return store.readJson(asHashRef(ref, label), label);
  if (!isPlainObject(ref)) throw new IntentCheckpointCorruptError(`检查点 ${label} 的内容引用无效。`);
  let value = await store.readJson(asHashRef(ref.b, label), label);
  for (const [at, hash] of parseHoles(ref.h, label)) {
    value = fillHole(value, at, await store.read(hash, label), label);
  }
  return value;
}

async function readJsonList<T>(store: IntentBlobStore, refs: unknown, label: string): Promise<T[]> {
  if (!Array.isArray(refs)) throw new IntentCheckpointCorruptError(`检查点 ${label} 的引用不完整。`);
  const out: T[] = [];
  for (let i = 0; i < refs.length; i++) {
    out.push(await readJsonValue(store, refs[i], `${label}[${i}]`) as T);
  }
  return out;
}

async function putProjectCheckpoint(
  store: IntentBlobStore,
  checkpoint: unknown,
): Promise<StoredProjectCheckpointRef> {
  const conversation = isPlainObject(checkpoint) ? checkpoint.conversation : undefined;
  if (isPlainObject(checkpoint) && isPlainObject(conversation) && Array.isArray(conversation.messages)) {
    const m = await putJsonList(store, conversation.messages);
    const body = await putJsonValue(store, { ...checkpoint, conversation: { ...conversation, messages: [] } });
    return typeof body === 'string' ? { b: body, m } : { ...body, m };
  }
  const body = await putJsonValue(store, checkpoint);
  return typeof body === 'string' ? { b: body } : { ...body };
}

async function readProjectCheckpoint(store: IntentBlobStore, ref: unknown): Promise<unknown> {
  const label = 'projectCheckpoint';
  if (typeof ref === 'string') return readJsonValue(store, ref, label);
  if (!isPlainObject(ref)) throw new IntentCheckpointCorruptError(`检查点 ${label} 的内容引用无效。`);
  const value = await readJsonValue(store, ref.h === undefined ? ref.b : { b: ref.b, h: ref.h }, label);
  if (ref.m !== undefined) {
    const conversation = isPlainObject(value) ? value.conversation : undefined;
    if (!isPlainObject(conversation)) {
      throw new IntentCheckpointCorruptError(`检查点 ${label} 缺少 conversation。`);
    }
    conversation.messages = await readJsonList(store, ref.m, `${label}.messages`);
  }
  return value;
}

async function putOptionalText(store: IntentBlobStore, content: string | null): Promise<string | null> {
  return content === null ? null : store.put(content);
}

/** 写入文件清单与跟踪路径；跟踪路径只存与清单键不同的部分。 */
export async function setStoredWorkspaceFiles(
  store: IntentBlobStore,
  stored: StoredIntentCheckpointV2,
  refs: Record<string, string | null>,
  trackedPaths: readonly string[],
): Promise<void> {
  const tree = await putWorkspaceTree(store, refs);
  stored.workspaceTreeRef = tree.root;
  if (Object.keys(tree.loose).length > 0) stored.looseFileRefs = tree.loose;
  else delete stored.looseFileRefs;

  const keys = new Set(Object.keys(refs));
  const tracked = new Set(trackedPaths);
  const extra = [...tracked].filter((p) => !keys.has(p));
  const omit = [...keys].filter((p) => !tracked.has(p));
  if (extra.length > 0) stored.trackedPathsExtra = extra;
  else delete stored.trackedPathsExtra;
  if (omit.length > 0) stored.trackedPathsOmit = omit;
  else delete stored.trackedPathsOmit;
}

export async function readStoredWorkspaceFileRefs(
  store: IntentBlobStore,
  stored: StoredIntentCheckpointV2,
): Promise<Record<string, string | null>> {
  const root = stored.workspaceTreeRef === null
    ? null
    : asHashRef(stored.workspaceTreeRef, '工作区文件清单');
  const refs = await readWorkspaceTree(store, root);
  if (stored.looseFileRefs !== undefined) {
    if (!isPlainObject(stored.looseFileRefs)) {
      throw new IntentCheckpointCorruptError('检查点文件清单引用不完整。');
    }
    for (const [rel, ref] of Object.entries(stored.looseFileRefs)) {
      setOwn(refs, rel, asOptionalHashRef(ref, rel));
    }
  }
  return refs;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new IntentCheckpointCorruptError(`检查点 ${label} 含有非字符串。`);
  }
  return value;
}

function trackedPathsOfStored(stored: StoredIntentCheckpointV2, fileKeys: string[]): string[] {
  const omit = new Set(stringList(stored.trackedPathsOmit, 'trackedPathsOmit'));
  return [
    ...fileKeys.filter((rel) => !omit.has(rel)),
    ...stringList(stored.trackedPathsExtra, 'trackedPathsExtra'),
  ];
}

export async function setStoredConversation(
  store: IntentBlobStore,
  stored: StoredIntentCheckpointV2,
  uiMessages: readonly UiChatMessage[],
  structuredMessages: readonly UnifiedMessage[],
): Promise<void> {
  stored.structuredMessageRefs = await putJsonList(store, structuredMessages);
  stored.uiMessageRefs = await putJsonList(store, uiMessages);
}

export async function readStoredConversation(
  store: IntentBlobStore,
  stored: Record<string, unknown>,
): Promise<{ structuredMessages: UnifiedMessage[]; uiMessages: UiChatMessage[] }> {
  return {
    structuredMessages: await readJsonList<UnifiedMessage>(store, stored.structuredMessageRefs, 'structuredMessages'),
    uiMessages: await readJsonList<UiChatMessage>(store, stored.uiMessageRefs, 'uiMessages'),
  };
}

export async function externalizeIntentCheckpoint(
  store: IntentBlobStore,
  archive: IntentCheckpointArchive,
): Promise<StoredIntentCheckpointV2> {
  const fileRefs: Record<string, string | null> = {};
  for (const [rel, content] of Object.entries(archive.workspaceFiles ?? {})) {
    if (content !== null && typeof content !== 'string') {
      throw new TypeError(`workspaceFiles[${rel}] 不是字符串或 null`);
    }
    setOwn(fileRefs, rel, content === null ? null : await store.put(content));
  }

  const stored: StoredIntentCheckpointV2 = {
    version: INTENT_CHECKPOINT_VERSION,
    storage: INTENT_CHECKPOINT_BLOB_STORAGE_V2,
    messageId: archive.messageId,
    sessionId: archive.sessionId,
    createdAt: archive.createdAt,
    userMessageTime: archive.userMessageTime,
    workspace: archive.workspace,
    workspaceRoot: archive.workspaceRoot,
    workspaceTreeRef: null,
    structuredMessageRefs: [],
    uiMessageRefs: [],
  };
  await setStoredWorkspaceFiles(store, stored, fileRefs, archive.trackedPaths ?? []);
  await setStoredConversation(store, stored, archive.uiMessages ?? [], archive.structuredMessages ?? []);

  if ('projectCheckpoint' in archive) {
    stored.projectCheckpointRef = archive.projectCheckpoint == null
      ? null
      : await putProjectCheckpoint(store, archive.projectCheckpoint);
  }
  if ('combinedCheckpoint' in archive) {
    stored.combinedCheckpoint = archive.combinedCheckpoint;
  }
  if (archive.sessionNotesContent !== undefined) {
    stored.sessionNotesRef = await putOptionalText(store, archive.sessionNotesContent);
  }
  if (archive.toolTraceDiffsRaw !== undefined) {
    stored.toolTraceDiffsRef = await putOptionalText(store, archive.toolTraceDiffsRaw);
  }
  return stored;
}

function readInlineHead(parsed: Record<string, unknown>): IntentCheckpointHead {
  const files: Record<string, IntentFileRef | null> = {};
  if (isPlainObject(parsed.workspaceFiles)) {
    for (const [rel, content] of Object.entries(parsed.workspaceFiles)) {
      if (content === null) setOwn(files, rel, null);
      else if (typeof content === 'string') setOwn(files, rel, { inline: content });
    }
  }
  return {
    messageId: String(parsed.messageId ?? ''),
    sessionId: String(parsed.sessionId ?? ''),
    createdAt: String(parsed.createdAt ?? ''),
    userMessageTime: typeof parsed.userMessageTime === 'number' ? parsed.userMessageTime : null,
    workspaceRoot: typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : '',
    workspace: parsed.workspace as IntentCheckpointArchive['workspace'],
    trackedPaths: Array.isArray(parsed.trackedPaths)
      ? parsed.trackedPaths.filter((p): p is string => typeof p === 'string')
      : [],
    files,
  };
}

/** 只读路径清单与内容引用，不读文件正文和消息。格式无法识别时抛 IntentCheckpointCorruptError。 */
export async function readIntentCheckpointHead(
  store: IntentBlobStore,
  parsed: unknown,
): Promise<IntentCheckpointHead> {
  if (!isPlainObject(parsed)) {
    throw new IntentCheckpointCorruptError('检查点归档不是对象。');
  }
  if (parsed.storage == null) return readInlineHead(parsed);
  if (parsed.storage !== INTENT_CHECKPOINT_BLOB_STORAGE
    && parsed.storage !== INTENT_CHECKPOINT_BLOB_STORAGE_V2) {
    throw new IntentCheckpointCorruptError(`未知的检查点存储格式: ${String(parsed.storage)}`);
  }
  const { messageId, sessionId, createdAt, workspaceRoot, userMessageTime, workspace } = parsed;
  if (typeof messageId !== 'string'
    || typeof sessionId !== 'string'
    || typeof createdAt !== 'string'
    || typeof workspaceRoot !== 'string'
    || !isPlainObject(workspace)
    || (userMessageTime !== null && typeof userMessageTime !== 'number')) {
    throw new IntentCheckpointCorruptError('检查点归档缺少必要字段。');
  }

  let hashRefs: Record<string, string | null>;
  let trackedPaths: string[];
  if (isStoredIntentCheckpointV2(parsed)) {
    hashRefs = await readStoredWorkspaceFileRefs(store, parsed);
    trackedPaths = trackedPathsOfStored(parsed, Object.keys(hashRefs));
  } else {
    if (!isPlainObject(parsed.workspaceFileRefs) || !Array.isArray(parsed.trackedPaths)) {
      throw new IntentCheckpointCorruptError('检查点内容引用不完整。');
    }
    hashRefs = {};
    for (const [rel, ref] of Object.entries(parsed.workspaceFileRefs)) {
      setOwn(hashRefs, rel, asOptionalHashRef(ref, rel));
    }
    trackedPaths = stringList(parsed.trackedPaths, 'trackedPaths');
  }

  const files: Record<string, IntentFileRef | null> = {};
  for (const [rel, hash] of Object.entries(hashRefs)) {
    setOwn(files, rel, hash === null ? null : { hash });
  }
  return {
    messageId,
    sessionId,
    createdAt,
    userMessageTime,
    workspaceRoot,
    workspace: workspace as unknown as IntentCheckpointArchive['workspace'],
    trackedPaths,
    files,
  };
}

export async function readIntentFileRef(
  store: IntentBlobStore,
  ref: IntentFileRef,
  label: string,
): Promise<string> {
  return 'inline' in ref ? ref.inline : store.read(ref.hash, label);
}

export async function materializeIntentCheckpoint(
  store: IntentBlobStore,
  parsed: unknown,
): Promise<IntentCheckpointArchive> {
  if (!isPlainObject(parsed)) {
    throw new IntentCheckpointCorruptError('检查点归档不是对象。');
  }
  if (parsed.storage == null) {
    return parsed as unknown as IntentCheckpointArchive;
  }
  const head = await readIntentCheckpointHead(store, parsed);
  const workspaceFiles: Record<string, string | null> = {};
  for (const [rel, ref] of Object.entries(head.files)) {
    setOwn(workspaceFiles, rel, ref === null ? null : await readIntentFileRef(store, ref, rel));
  }
  const { structuredMessages, uiMessages } = await readStoredConversation(store, parsed);

  const archive: IntentCheckpointArchive = {
    version: INTENT_CHECKPOINT_VERSION,
    messageId: head.messageId,
    sessionId: head.sessionId,
    createdAt: head.createdAt,
    userMessageTime: head.userMessageTime,
    workspace: head.workspace,
    workspaceRoot: head.workspaceRoot,
    workspaceFiles,
    trackedPaths: head.trackedPaths,
    structuredMessages,
    uiMessages,
  };

  if ('projectCheckpointRef' in parsed) {
    archive.projectCheckpoint = parsed.projectCheckpointRef === null
      ? null
      : await readProjectCheckpoint(store, parsed.projectCheckpointRef) as IntentCheckpointArchive['projectCheckpoint'];
  }
  if ('combinedCheckpoint' in parsed) {
    archive.combinedCheckpoint = parsed.combinedCheckpoint as IntentCheckpointArchive['combinedCheckpoint'];
  }
  if ('sessionNotesRef' in parsed) {
    const hash = asOptionalHashRef(parsed.sessionNotesRef, 'sessionNotes');
    archive.sessionNotesContent = hash === null ? null : await store.read(hash, 'sessionNotes');
  }
  if ('toolTraceDiffsRef' in parsed) {
    const hash = asOptionalHashRef(parsed.toolTraceDiffsRef, 'toolTraceDiffs');
    archive.toolTraceDiffsRaw = hash === null ? null : await store.read(hash, 'toolTraceDiffs');
  }
  return archive;
}

function addJsonRefHashes(ref: unknown, refs: Set<string>): boolean {
  if (typeof ref === 'string') {
    if (!BLOB_HASH_RE.test(ref)) return false;
    refs.add(ref);
    return true;
  }
  if (!isPlainObject(ref) || typeof ref.b !== 'string' || !BLOB_HASH_RE.test(ref.b)) return false;
  refs.add(ref.b);
  if (ref.h === undefined) return true;
  if (!Array.isArray(ref.h)) return false;
  for (const hole of ref.h) {
    if (!Array.isArray(hole) || typeof hole[1] !== 'string' || !BLOB_HASH_RE.test(hole[1])) return false;
    refs.add(hole[1]);
  }
  return true;
}

function addJsonRefList(list: unknown, refs: Set<string>): boolean {
  return Array.isArray(list) && list.every((ref) => addJsonRefHashes(ref, refs));
}

function addOptionalHash(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string' && BLOB_HASH_RE.test(value)) refs.add(value);
}

/** 返回引用集合；归档不可信时返回 null，回收必须整次放弃。 */
async function blobRefsFromArchive(
  store: IntentBlobStore,
  parsed: unknown,
  visitedTrees: Set<string>,
): Promise<Set<string> | null> {
  if (!isPlainObject(parsed)) return null;
  if (parsed.storage == null) return new Set();
  const refs = new Set<string>();

  if (parsed.storage === INTENT_CHECKPOINT_BLOB_STORAGE) {
    if (!isPlainObject(parsed.workspaceFileRefs)
      || !Array.isArray(parsed.structuredMessageRefs)
      || !Array.isArray(parsed.uiMessageRefs)) {
      return null;
    }
    for (const value of Object.values(parsed.workspaceFileRefs)) addOptionalHash(value, refs);
    for (const value of parsed.structuredMessageRefs) addOptionalHash(value, refs);
    for (const value of parsed.uiMessageRefs) addOptionalHash(value, refs);
    if ('projectCheckpointRef' in parsed) addOptionalHash(parsed.projectCheckpointRef, refs);
    if ('sessionNotesRef' in parsed) addOptionalHash(parsed.sessionNotesRef, refs);
    if ('toolTraceDiffsRef' in parsed) addOptionalHash(parsed.toolTraceDiffsRef, refs);
    return refs;
  }

  if (!isStoredIntentCheckpointV2(parsed)) return null;
  const tree = parsed.workspaceTreeRef;
  if (tree !== null && (typeof tree !== 'string' || !BLOB_HASH_RE.test(tree))) return null;
  try {
    await collectWorkspaceTreeRefs(store, tree, refs, visitedTrees);
  } catch (err) {
    if (err instanceof IntentCheckpointCorruptError) return null;
    throw err;
  }
  if (parsed.looseFileRefs !== undefined) {
    if (!isPlainObject(parsed.looseFileRefs)) return null;
    for (const value of Object.values(parsed.looseFileRefs)) addOptionalHash(value, refs);
  }
  if (!addJsonRefList(parsed.structuredMessageRefs, refs) || !addJsonRefList(parsed.uiMessageRefs, refs)) {
    return null;
  }
  const project = parsed.projectCheckpointRef;
  if (project !== undefined && project !== null) {
    if (!isPlainObject(project)) return null;
    if (!addJsonRefHashes(project.h === undefined ? project.b : { b: project.b, h: project.h }, refs)) return null;
    if (project.m !== undefined && !addJsonRefList(project.m, refs)) return null;
  }
  addOptionalHash(parsed.sessionNotesRef, refs);
  addOptionalHash(parsed.toolTraceDiffsRef, refs);
  return refs;
}

async function collectReferencedBlobHashes(
  store: IntentBlobStore,
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
  const visitedTrees = new Set<string>();
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
    const refs = await blobRefsFromArchive(store, parsed, visitedTrees);
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
  const referenced = await collectReferencedBlobHashes(
    new IntentBlobStore(sessionDir, sessionId),
    sessionDir,
    sessionId,
  );
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
