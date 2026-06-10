import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assertAgentMemoryWriteAllowed,
  assertAgentMemoryShellCommandAllowed,
  canonicalizeMemoryToolPath,
  createRememberSignalWriteGuard,
  hasExplicitRememberWriteRequest,
  isMemoryToolPath,
  resolveMemoryWritePath,
  registerAgentMemoryWriteGuard,
  resolveMemoryRootForPath,
  resolveMessageForRememberWriteGuard,
  shellCommandTargetsMemoryWrite,
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

  it('user-memory 别名归一化到 data/user-memory', () => {
    const workDir = path.resolve('D:/proj');
    process.env.ICE_DATA_DIR = path.join(workDir, 'data');
    process.env.ICE_MEMORY_DIR = path.join(workDir, 'data/memory-files');
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'data/user-memory');

    const canonical = canonicalizeMemoryToolPath('user-memory/user_commit_style.md', workDir);
    expect(canonical).toBe(path.join(workDir, 'data/user-memory/user_commit_style.md'));
    expect(isMemoryToolPath('user-memory/user_commit_style.md', workDir)).toBe(true);
    expect(resolveMemoryRootForPath(canonical)).toBe(path.join(workDir, 'data/user-memory'));

    delete process.env.ICE_DATA_DIR;
    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('run_command seed 脚本无 remember 时被拒', () => {
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => 'Turn 3 验收'));
    expect(assertAgentMemoryShellCommandAllowed('node scripts/verify_memory_seed.cjs')).toMatch(/remember/i);
    expect(shellCommandTargetsMemoryWrite('node scripts/seed_memory.cjs')).toBe(true);
  });

  it('resolveMessageForRememberWriteGuard 优先含记住的 trigger 消息', () => {
    const turn1 = '【Turn 1】模拟 zip 安装 MySQL，不要写长期记忆';
    const turn3 = '记住，Git commit message 一律用中文，subject 不超过 50 字。';
    expect(
      resolveMessageForRememberWriteGuard([turn1, turn3]),
    ).toBe(turn3);
    expect(hasExplicitRememberWriteRequest(
      resolveMessageForRememberWriteGuard([turn1, turn3]),
    )).toBe(true);
  });

  it('验收 Turn3 文档格式「记住，…」引号内直接引语仍放行', () => {
    const turn3doc = '1. 明确偏好（含信号词）：「记住，Git commit message 一律用中文，subject 不超过 50 字，body 用 bullet。」';
    expect(hasExplicitRememberWriteRequest(turn3doc)).toBe(true);
  });

  it('type:user 写入 memory-files 路径时重定向到 user-memory', () => {
    const workDir = path.resolve('D:/proj');
    process.env.ICE_DATA_DIR = path.join(workDir, 'data');
    process.env.ICE_MEMORY_DIR = path.join(workDir, 'data/memory-files');
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'data/user-memory');

    const content = '---\ntype: user\nname: test\n---\nbody';
    const wrong = resolveMemoryWritePath('memory-files/user_api_test_note.md', workDir, content);
    expect(wrong).toBe(path.join(workDir, 'data/user-memory/user_api_test_note.md'));

    const correct = resolveMemoryWritePath('user-memory/user_api_test_note.md', workDir, content);
    expect(correct).toBe(path.join(workDir, 'data/user-memory/user_api_test_note.md'));

    delete process.env.ICE_DATA_DIR;
    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
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

  it('write_file type:user 误写 memory-files 时重定向到 user-memory', async () => {
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'user-memory');
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    const { createFileTools } = await import('../../../src/tools/builtin/file-tools.js');
    const tools = createFileTools(workDir);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;
    const result = await writeTool.handler({
      path: path.join('memory-files', 'user_redirect_test.md'),
      content: '---\ntype: user\ndescription: redirect test\n---\nhello',
    });
    expect(result.success).toBe(true);
    const userPath = path.join(workDir, 'user-memory', 'user_redirect_test.md');
    const wrongPath = path.join(memoryDir, 'user_redirect_test.md');
    const { access, readFile } = await import('node:fs/promises');
    await expect(access(userPath)).resolves.toBeUndefined();
    await expect(access(wrongPath)).rejects.toThrow();
    expect(await readFile(userPath, 'utf-8')).toContain('hello');
    delete process.env.ICE_USER_MEMORY_DIR;
  });
});
