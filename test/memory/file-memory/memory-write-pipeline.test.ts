import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assertAgentMemoryWriteAllowed,
  createRememberSignalWriteGuard,
  registerAgentMemoryWriteGuard,
  resolveMemoryRootForPath,
} from '../../../src/memory/file-memory/memory-write-pipeline.js';
import { DEFAULT_MEMORY_DIR } from '../../../src/memory/file-memory/memory-config.js';

describe('memory-write-pipeline', () => {
  afterEach(() => {
    registerAgentMemoryWriteGuard(null);
  });

  it('非记忆路径不触发门控', () => {
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => ''));
    expect(assertAgentMemoryWriteAllowed('/tmp/not-memory/foo.md')).toBeNull();
  });

  it('记忆路径无 remember 信号时被拒绝', () => {
    const memoryRoot = path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR);
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '帮我装 mysql'));
    const target = path.join(memoryRoot, 'project_overview.md');
    expect(resolveMemoryRootForPath(target)).not.toBeNull();
    expect(assertAgentMemoryWriteAllowed(target)).toMatch(/remember/i);
  });

  it('记忆路径含 remember 信号时允许', () => {
    const memoryRoot = path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR);
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，commit 用中文'));
    const target = path.join(memoryRoot, 'user_commit_style.md');
    expect(assertAgentMemoryWriteAllowed(target)).toBeNull();
  });
});

describe('file-tools memory write guard', () => {
  let workDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'ice-mem-guard-'));
    memoryDir = path.join(workDir, 'memory-files');
    process.env.ICE_MEMORY_DIR = memoryDir;
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => ''));
  });

  afterEach(async () => {
    registerAgentMemoryWriteGuard(null);
    delete process.env.ICE_MEMORY_DIR;
    await rm(workDir, { recursive: true, force: true });
  });

  it('write_file 写记忆目录无 remember 时被拒绝', async () => {
    const { createFileTools } = await import('../../../src/tools/builtin/file-tools.js');
    const tools = createFileTools(workDir);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;
    const rel = path.join('memory-files', 'user_test.md');
    const result = await writeTool.handler({
      path: rel,
      content: '---\ntype: user\n---\n测试',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/remember/i);
  });
});
