/**
 * Intent Checkpoint 的工作区文件清单：按目录拆成内容寻址的树（与 git tree 同理）。
 *
 * 每个目录一个 blob：`{"t":1,"e":[[name,"f",fileHash|null],[name,"d",treeHash]]}`，按名字排序。
 * 没变过的目录在相邻检查点之间是同一个 blob，几千个文件的清单只在改动的目录上产生新数据。
 * 带空段、`.`、`..` 的路径放不进树，由调用方另存为 loose 清单。
 */

import {
  BLOB_HASH_RE,
  IntentCheckpointCorruptError,
  setOwn,
  type IntentBlobStore,
} from './intent-checkpoint-blob-io.js';

type TreeEntry = [name: string, kind: 'f', ref: string | null] | [name: string, kind: 'd', ref: string];

interface DirNode {
  files: Map<string, string | null>;
  dirs: Map<string, DirNode>;
}

export function isTreeablePath(relPath: string): boolean {
  if (!relPath) return false;
  return relPath.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] === b[1]) return 0;
  return a[1] < b[1] ? -1 : 1;
}

async function putDir(store: IntentBlobStore, node: DirNode): Promise<string> {
  const entries: TreeEntry[] = [];
  for (const [name, child] of node.dirs) entries.push([name, 'd', await putDir(store, child)]);
  for (const [name, ref] of node.files) entries.push([name, 'f', ref]);
  entries.sort(compareEntries);
  return store.put(JSON.stringify({ t: 1, e: entries }));
}

/** 写入文件清单；返回根目录树哈希（清单为空时为 null）和放不进树的路径。 */
export async function putWorkspaceTree(
  store: IntentBlobStore,
  refs: Record<string, string | null>,
): Promise<{ root: string | null; loose: Record<string, string | null> }> {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  const loose: Record<string, string | null> = {};
  let treeCount = 0;
  for (const [rel, ref] of Object.entries(refs)) {
    if (!isTreeablePath(rel)) {
      setOwn(loose, rel, ref);
      continue;
    }
    const parts = rel.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], ref);
    treeCount++;
  }
  return { root: treeCount > 0 ? await putDir(store, root) : null, loose };
}

function parseTree(raw: unknown, hash: string): TreeEntry[] {
  const record = raw as { t?: unknown; e?: unknown } | null;
  if (!record || typeof record !== 'object' || record.t !== 1 || !Array.isArray(record.e)) {
    throw new IntentCheckpointCorruptError(`检查点目录树格式无法识别（${hash}）。`);
  }
  for (const entry of record.e as unknown[]) {
    const ok = Array.isArray(entry)
      && entry.length === 3
      && typeof entry[0] === 'string'
      && entry[0] !== ''
      && !entry[0].includes('/')
      && (
        (entry[1] === 'f' && (entry[2] === null || (typeof entry[2] === 'string' && BLOB_HASH_RE.test(entry[2]))))
        || (entry[1] === 'd' && typeof entry[2] === 'string' && BLOB_HASH_RE.test(entry[2]))
      );
    if (!ok) throw new IntentCheckpointCorruptError(`检查点目录树含有非法条目（${hash}）。`);
  }
  return record.e as TreeEntry[];
}

async function readTree(store: IntentBlobStore, hash: string): Promise<TreeEntry[]> {
  return parseTree(await store.readJson(hash, '工作区文件清单'), hash);
}

/** 展开成「相对路径 → 文件内容哈希（null 表示当时不存在）」。 */
export async function readWorkspaceTree(
  store: IntentBlobStore,
  root: string | null,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (root === null) return out;
  const walk = async (hash: string, prefix: string): Promise<void> => {
    for (const [name, kind, ref] of await readTree(store, hash)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (kind === 'd') await walk(ref as string, rel);
      else setOwn(out, rel, ref);
    }
  };
  await walk(root, '');
  return out;
}

/** 把树本身和树里引用的文件 blob 都记进 refs（回收用）；共享子树只走一次。 */
export async function collectWorkspaceTreeRefs(
  store: IntentBlobStore,
  root: string | null,
  refs: Set<string>,
  visited: Set<string>,
): Promise<void> {
  if (root === null) return;
  const walk = async (hash: string): Promise<void> => {
    refs.add(hash);
    if (visited.has(hash)) return;
    visited.add(hash);
    for (const [, kind, ref] of await readTree(store, hash)) {
      if (ref === null) continue;
      if (kind === 'd') await walk(ref);
      else refs.add(ref);
    }
  };
  await walk(root);
}
