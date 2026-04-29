/**
 * memory-dream 备份功能单元测试。
 *
 * 覆盖：
 * - backupBeforeDream: 备份创建、manifest 写入、文件复制
 * - pruneOldBackups: 滚动清理旧备份
 * - restoreFromBackup: 从备份恢复文件
 * - listBackups: 列出可用备份
 * - 边界情况: 无文件需要备份、备份目录不存在、备份禁用
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMemoryDream } from './memory-dream.js';

// ─── 测试工具 ───

let tempDir: string;
let backupDir: string;

async function writeMemoryFile(dir: string, filename: string, content?: string) {
  const fileContent = content || `---
name: ${filename.replace('.md', '')}
description: test memory
type: project
---

Content of ${filename}`;
  await fs.writeFile(path.join(dir, filename), fileContent, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `dream-backup-test-${randomUUID()}`);
  backupDir = path.join(os.tmpdir(), `dream-backups-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
});

// ═══════════════════════════════════════════════
// backupBeforeDream
// ═══════════════════════════════════════════════

describe('backupBeforeDream', () => {
  it('备份将被覆盖的文件', async () => {
    await writeMemoryFile(tempDir, 'user_role.md', 'original content of user_role');
    await writeMemoryFile(tempDir, 'MEMORY.md', '# Index\n- user_role.md');

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    const parsed = {
      file_writes: [{ filename: 'user_role.md', content: 'new content' }],
      file_deletes: [],
      new_index: '# Updated Index',
      summary: 'Updated user role',
    };

    const backupPath = await dream.backupBeforeDream(tempDir, parsed);
    expect(backupPath).not.toBeNull();

    // 检查备份目录中有文件
    const backupFiles = await fs.readdir(backupPath!);
    expect(backupFiles).toContain('user_role.md');
    expect(backupFiles).toContain('MEMORY.md');
    expect(backupFiles).toContain('manifest.json');

    // 检查备份内容是原始内容
    const backedUpContent = await fs.readFile(path.join(backupPath!, 'user_role.md'), 'utf-8');
    expect(backedUpContent).toBe('original content of user_role');
  });

  it('备份将被删除的文件', async () => {
    await writeMemoryFile(tempDir, 'old_note.md', 'old content');

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    const parsed = {
      file_writes: [],
      file_deletes: ['old_note.md'],
      summary: 'Deleted old note',
    };

    const backupPath = await dream.backupBeforeDream(tempDir, parsed);
    expect(backupPath).not.toBeNull();

    const backupFiles = await fs.readdir(backupPath!);
    expect(backupFiles).toContain('old_note.md');

    // 检查 manifest
    const manifest = JSON.parse(await fs.readFile(path.join(backupPath!, 'manifest.json'), 'utf-8'));
    expect(manifest.backedUpFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: 'old_note.md', reason: 'will_be_deleted' }),
      ]),
    );
  });

  it('没有文件需要备份时返回 null', async () => {
    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    const parsed = {
      file_writes: [],
      file_deletes: [],
      summary: 'Nothing to do',
    };

    const backupPath = await dream.backupBeforeDream(tempDir, parsed);
    expect(backupPath).toBeNull();
  });

  it('文件不存在时跳过（新建而非覆盖）', async () => {
    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    const parsed = {
      file_writes: [{ filename: 'brand_new.md', content: 'new content' }],
      file_deletes: [],
      summary: 'Created new file',
    };

    const backupPath = await dream.backupBeforeDream(tempDir, parsed);
    // brand_new.md 不存在于 memoryDir，所以没有实际备份
    expect(backupPath).toBeNull();
  });

  it('备份禁用时返回 null', async () => {
    await writeMemoryFile(tempDir, 'note.md');

    const dream = createMemoryDream({
      enableBackup: false,
      backupDir,
      maxBackups: 3,
    });

    const parsed = {
      file_writes: [{ filename: 'note.md', content: 'new' }],
      file_deletes: [],
    };

    const backupPath = await dream.backupBeforeDream(tempDir, parsed);
    expect(backupPath).toBeNull();
  });

  it('manifest 包含正确的元数据', async () => {
    await writeMemoryFile(tempDir, 'note.md');

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    const parsed = {
      file_writes: [{ filename: 'note.md', content: 'updated' }],
      file_deletes: [],
      new_index: '# New Index',
      summary: 'Test summary',
      actions: [{ type: 'update', files: ['note.md'], reason: 'test' }],
    };

    const backupPath = await dream.backupBeforeDream(tempDir, parsed);
    const manifest = JSON.parse(await fs.readFile(path.join(backupPath!, 'manifest.json'), 'utf-8'));

    expect(manifest.timestamp).toBeDefined();
    expect(manifest.dreamSummary).toBe('Test summary');
    expect(manifest.dreamActions).toHaveLength(1);
    expect(manifest.backedUpFiles).toHaveLength(1); // note.md（MEMORY.md 不存在所以不备份）
  });
});

// ═══════════════════════════════════════════════
// pruneOldBackups（通过多次 backup 间接测试）
// ═══════════════════════════════════════════════

describe('pruneOldBackups', () => {
  it('保留最新的 maxBackups 份，删除更早的', async () => {
    await writeMemoryFile(tempDir, 'note.md');

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 2, // 只保留 2 份
    });

    const parsed = {
      file_writes: [{ filename: 'note.md', content: 'v1' }],
      file_deletes: [],
    };

    // 创建 3 次备份
    await dream.backupBeforeDream(tempDir, parsed);
    await new Promise(r => setTimeout(r, 50)); // 确保时间戳不同
    await dream.backupBeforeDream(tempDir, parsed);
    await new Promise(r => setTimeout(r, 50));
    await dream.backupBeforeDream(tempDir, parsed);

    // 检查只保留了 2 份
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const backupDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('backup-'));
    expect(backupDirs.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════
// restoreFromBackup
// ═══════════════════════════════════════════════

describe('restoreFromBackup', () => {
  it('从最新备份恢复文件', async () => {
    // 创建原始文件
    await writeMemoryFile(tempDir, 'note.md', 'original content');
    await writeMemoryFile(tempDir, 'MEMORY.md', '# Original Index');

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    // 创建备份
    const parsed = {
      file_writes: [{ filename: 'note.md', content: 'new content' }],
      file_deletes: [],
      new_index: '# New Index',
    };
    await dream.backupBeforeDream(tempDir, parsed);

    // 模拟 Dream 修改了文件
    await fs.writeFile(path.join(tempDir, 'note.md'), 'new content', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '# New Index', 'utf-8');

    // 恢复
    const restored = await dream.restoreFromBackup(tempDir);
    expect(restored).toBe(2); // note.md + MEMORY.md

    // 检查内容已恢复
    const noteContent = await fs.readFile(path.join(tempDir, 'note.md'), 'utf-8');
    expect(noteContent).toBe('original content');
    const indexContent = await fs.readFile(path.join(tempDir, 'MEMORY.md'), 'utf-8');
    expect(indexContent).toBe('# Original Index');
  });

  it('从指定备份恢复', async () => {
    await writeMemoryFile(tempDir, 'note.md', 'v1');

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    const parsed = {
      file_writes: [{ filename: 'note.md', content: 'v2' }],
      file_deletes: [],
    };

    const backupPath = await dream.backupBeforeDream(tempDir, parsed);
    const backupName = path.basename(backupPath!);

    // 修改文件
    await fs.writeFile(path.join(tempDir, 'note.md'), 'v2', 'utf-8');

    // 从指定备份恢复
    const restored = await dream.restoreFromBackup(tempDir, backupName);
    expect(restored).toBe(1);

    const content = await fs.readFile(path.join(tempDir, 'note.md'), 'utf-8');
    expect(content).toBe('v1');
  });

  it('无备份时返回 0', async () => {
    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });

    await fs.mkdir(backupDir, { recursive: true });
    const restored = await dream.restoreFromBackup(tempDir);
    expect(restored).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// listBackups
// ═══════════════════════════════════════════════

describe('listBackups', () => {
  it('列出所有备份及其元数据', async () => {
    await writeMemoryFile(tempDir, 'note.md');

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 5,
    });

    const parsed = {
      file_writes: [{ filename: 'note.md', content: 'new' }],
      file_deletes: [],
    };

    await dream.backupBeforeDream(tempDir, parsed);
    await new Promise(r => setTimeout(r, 50));
    await dream.backupBeforeDream(tempDir, parsed);

    const backups = await dream.listBackups();
    expect(backups.length).toBe(2);
    expect(backups[0].fileCount).toBe(1);
    expect(backups[0].timestamp).toBeDefined();
    // 最新的排在前面
    expect(backups[0].name > backups[1].name).toBe(true);
  });

  it('备份目录不存在时返回空数组', async () => {
    const dream = createMemoryDream({
      enableBackup: true,
      backupDir: '/nonexistent/path',
      maxBackups: 3,
    });

    const backups = await dream.listBackups();
    expect(backups).toEqual([]);
  });
});
