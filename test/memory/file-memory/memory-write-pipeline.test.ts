import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assertAgentMemoryWriteAllowed,
  createRememberSignalWriteGuard,
  hasExplicitRememberWriteRequest,
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

  it('验收提示词中的否定/元说明「记住」不误放行', () => {
    expect(hasExplicitRememberWriteRequest('本轮用户侧不使用记忆指令（验收说明，非记忆请求）')).toBe(false);
    expect(hasExplicitRememberWriteRequest('本轮用户侧不使用 remember 类指令（验收说明，非记忆请求）')).toBe(false);
    expect(hasExplicitRememberWriteRequest('帮我装 mysql，不要写长期记忆')).toBe(false);
    expect(hasExplicitRememberWriteRequest(
      'Long-term memory writes are only allowed when the user explicitly asks you to remember something',
    )).toBe(false);
  });

  it('英文 remember 祈使句仍放行', () => {
    expect(hasExplicitRememberWriteRequest('remember, commit messages must be in Chinese')).toBe(true);
    expect(hasExplicitRememberWriteRequest('Please remember this workflow for Smart Mode blocks')).toBe(true);
  });

  it('「不要」单独出现不授权写盘', () => {
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '不要 write_file 到 memory-files'));
    const memoryRoot = path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR);
    expect(assertAgentMemoryWriteAllowed(path.join(memoryRoot, 'x.md'))).toMatch(/remember/i);
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
