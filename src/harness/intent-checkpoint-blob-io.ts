/**
 * Intent Checkpoint blob 文件读写。
 *
 * 文件名是正文 UTF-8 的 sha256。正文够大且压得下去时用 brotli 落盘，文件头加 COMPRESSED_MAGIC；
 * 0xFF 不会出现在合法 UTF-8 里，旧版未压缩的 blob 不会被误判，两种文件可以混放。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

const COMPRESSED_MAGIC = Buffer.from([0xff, 0x69, 0x63, 0x01]);
const COMPRESS_MIN_BYTES = 1024;
/** 压缩后至少省 10% 才落压缩版，否则读的时候白白多解一次。 */
const COMPRESS_MAX_RATIO = 0.9;
const BROTLI_QUALITY = 5;
/** 单次操作内缓存的单个 blob 上限；目录树、消息这类小 blob 会被多份归档反复引用。 */
const READ_CACHE_MAX_CHARS = 256 * 1024;

export class IntentCheckpointCorruptError extends Error {
  readonly code = 'INTENT_CHECKPOINT_CORRUPT';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IntentCheckpointCorruptError';
  }
}

export function intentCheckpointBlobsDir(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, sessionId, 'checkpoints', 'blobs');
}

export function hashIntentBlobContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function asHashRef(value: unknown, label: string): string {
  if (typeof value === 'string' && BLOB_HASH_RE.test(value)) return value;
  throw new IntentCheckpointCorruptError(`检查点 ${label} 的内容引用无效。`);
}

export function asOptionalHashRef(value: unknown, label: string): string | null {
  if (value === null) return null;
  return asHashRef(value, label);
}

/** 文件路径、JSON 键都可能是 `__proto__`，普通赋值会被吞掉。 */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

export async function encodeIntentBlobFile(content: string): Promise<Buffer> {
  const raw = Buffer.from(content, 'utf8');
  if (raw.length < COMPRESS_MIN_BYTES) return raw;
  const packed = await brotliCompress(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  if (packed.length + COMPRESSED_MAGIC.length > raw.length * COMPRESS_MAX_RATIO) return raw;
  return Buffer.concat([COMPRESSED_MAGIC, packed]);
}

function isCompressedBlob(data: Buffer): boolean {
  return data.length >= COMPRESSED_MAGIC.length
    && data.subarray(0, COMPRESSED_MAGIC.length).equals(COMPRESSED_MAGIC);
}

export async function decodeIntentBlobFile(data: Buffer): Promise<string> {
  if (isCompressedBlob(data)) {
    return (await brotliDecompress(data.subarray(COMPRESSED_MAGIC.length))).toString('utf8');
  }
  return data.toString('utf8');
}

/**
 * 旧版未压缩的 blob 就地换成压缩编码，文件名（正文哈希）不变。返回省下的字节数。
 * 正文与文件名对不上的 blob 原样保留，留给读取方报损坏。
 */
export async function recompressIntentBlobFile(dir: string, hash: string): Promise<number> {
  const file = path.join(dir, hash);
  let data: Buffer;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size < COMPRESS_MIN_BYTES) return 0;
      const head = Buffer.alloc(COMPRESSED_MAGIC.length);
      await handle.read(head, 0, head.length, 0);
      if (isCompressedBlob(head)) return 0;
    } finally {
      await handle.close();
    }
    data = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const content = data.toString('utf8');
  if (hashIntentBlobContent(content) !== hash) return 0;
  const encoded = await encodeIntentBlobFile(content);
  if (encoded.length >= data.length) return 0;
  await writeFileAtomic(file, encoded);
  return data.length - encoded.length;
}

/**
 * 一次操作内的 blob 访问。写入前列一次目录，之后靠内存集合判断是否已存在；
 * 写入方必须持有该会话的 checkpoint 索引锁，避免与回收并发。
 */
export class IntentBlobStore {
  readonly dir: string;
  private existing: Set<string> | null = null;
  private readonly readCache = new Map<string, string>();

  constructor(sessionDir: string, sessionId: string) {
    this.dir = intentCheckpointBlobsDir(sessionDir, sessionId);
  }

  async put(content: string): Promise<string> {
    const hash = hashIntentBlobContent(content);
    const existing = await this.existingHashes();
    if (existing.has(hash)) return hash;
    await writeFileAtomic(path.join(this.dir, hash), await encodeIntentBlobFile(content));
    existing.add(hash);
    return hash;
  }

  async read(hash: string, label: string): Promise<string> {
    const cached = this.readCache.get(hash);
    if (cached !== undefined) return cached;
    let data: Buffer;
    try {
      data = await fs.readFile(path.join(this.dir, asHashRef(hash, label)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new IntentCheckpointCorruptError(
          `检查点缺少 ${label} 的内容（${hash}），已停止使用这份快照。`,
          { cause: err },
        );
      }
      throw err;
    }
    let content: string;
    try {
      content = await decodeIntentBlobFile(data);
    } catch (err) {
      throw new IntentCheckpointCorruptError(`检查点 ${label} 的内容无法解压（${hash}）。`, { cause: err });
    }
    if (hashIntentBlobContent(content) !== hash) {
      throw new IntentCheckpointCorruptError(`检查点 ${label} 的内容与哈希不一致（${hash}）。`);
    }
    if (content.length <= READ_CACHE_MAX_CHARS) this.readCache.set(hash, content);
    return content;
  }

  async readJson(hash: string, label: string): Promise<unknown> {
    const raw = await this.read(hash, label);
    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      throw new IntentCheckpointCorruptError(`检查点 ${label} 不是合法 JSON（${hash}）。`, { cause: err });
    }
  }

  private async existingHashes(): Promise<Set<string>> {
    if (this.existing) return this.existing;
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.existing = new Set(names.filter((name) => BLOB_HASH_RE.test(name)));
    return this.existing;
  }
}
