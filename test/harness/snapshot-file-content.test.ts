import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decodeSnapshotContent,
  encodeSnapshotContent,
  MAX_SNAPSHOT_BINARY_BYTES,
} from '../../src/harness/snapshot-file-content.js';
import {
  applyWorkspaceFileSnapshot,
  captureWorkspaceFileSnapshot,
} from '../../src/harness/workspace-snapshot.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0x80,
]);
/** 「中文」的 GBK 编码，不是合法 UTF-8 */
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);

describe('snapshot-file-content 编解码', () => {
  it('UTF-8 文本原样保存', () => {
    const encoded = encodeSnapshotContent(Buffer.from('const a = "中文";\n', 'utf-8'));
    expect(encoded).toBe('const a = "中文";\n');
    expect(decodeSnapshotContent(encoded)).toEqual({ kind: 'text', text: 'const a = "中文";\n' });
  });

  it('二进制、GBK、含 U+FFFD 的文本都按字节无损往返', () => {
    for (const bytes of [PNG_BYTES, GBK_BYTES, Buffer.from('bad \uFFFD char', 'utf-8')]) {
      const decoded = decodeSnapshotContent(encodeSnapshotContent(bytes));
      expect(decoded.kind).toBe('binary');
      expect(decoded.kind === 'binary' && decoded.data.equals(bytes)).toBe(true);
    }
  });

  it('超大二进制只记存在，解码为 skip', () => {
    const big = Buffer.alloc(MAX_SNAPSHOT_BINARY_BYTES + 1, 0);
    const encoded = encodeSnapshotContent(big);
    expect(encoded.length).toBeLessThan(64);
    expect(decodeSnapshotContent(encoded).kind).toBe('skip');
  });

  it('旧版按文本读坏的二进制解码为 skip', () => {
    expect(decodeSnapshotContent(PNG_BYTES.toString('utf-8')).kind).toBe('skip');
    expect(decodeSnapshotContent(GBK_BYTES.toString('utf-8')).kind).toBe('skip');
  });
});

describe('回退快照写回二进制文件', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-snapshot-binary-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('快照后改写的 PNG / GBK 文件能逐字节还原', async () => {
    await fs.writeFile(path.join(root, 'icon.png'), PNG_BYTES);
    await fs.writeFile(path.join(root, 'legacy.java'), GBK_BYTES);
    await fs.writeFile(path.join(root, 'a.txt'), 'hello', 'utf-8');

    const snapshot = await captureWorkspaceFileSnapshot(root, ['icon.png', 'legacy.java', 'a.txt']);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    await fs.writeFile(path.join(root, 'icon.png'), Buffer.from('overwritten'));
    await fs.writeFile(path.join(root, 'legacy.java'), 'changed', 'utf-8');
    await fs.writeFile(path.join(root, 'a.txt'), 'changed', 'utf-8');

    await applyWorkspaceFileSnapshot(root, snapshot);

    expect((await fs.readFile(path.join(root, 'icon.png'))).equals(PNG_BYTES)).toBe(true);
    expect((await fs.readFile(path.join(root, 'legacy.java'))).equals(GBK_BYTES)).toBe(true);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('hello');
  });

  it('旧版损坏的快照不写回，保留磁盘现状，其余文件照常还原', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const current = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    await fs.writeFile(path.join(root, 'icon.png'), current);
    await fs.writeFile(path.join(root, 'a.txt'), 'changed', 'utf-8');

    await applyWorkspaceFileSnapshot(root, {
      'icon.png': PNG_BYTES.toString('utf-8'),
      'a.txt': 'hello',
    });

    expect((await fs.readFile(path.join(root, 'icon.png'))).equals(current)).toBe(true);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('hello');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('icon.png'));
  });
});
