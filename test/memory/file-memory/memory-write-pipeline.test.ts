import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assertAgentMemoryWriteAllowed,
  assertAgentMemoryShellCommandAllowed,
  canonicalizeMemoryToolPath,
  createRememberSignalWriteGuard,
  createLongTermMemoryWriteCap,
  hasExplicitRememberWriteRequest,
  isMemoryToolPath,
  resolveMemoryWritePath,
  registerAgentMemoryWriteGuard,
  registerLongTermMemoryWriteCap,
  recordLongTermMemoryWriteSuccess,
  recordShellMemoryWriteSuccess,
  extractMemoryWriteBasenamesFromShellCommand,
  resetSessionLongTermMemoryWriteCaps,
  resolveMemoryRootForPath,
  resolveMessageForRememberWriteGuard,
  shellCommandTargetsMemoryWrite,
  shouldForceUserMemoryLocation,
  shouldRejectMixedTopicMemory,
} from '../../../src/memory/file-memory/memory-write-pipeline.js';
import { DEFAULT_MEMORY_DIR } from '../../../src/memory/file-memory/memory-config.js';

describe('memory-write-pipeline', () => {
  afterEach(() => {
    registerAgentMemoryWriteGuard(null);
    registerLongTermMemoryWriteCap(null);
    resetSessionLongTermMemoryWriteCaps();
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
    expect(assertAgentMemoryWriteAllowed(target)).toMatch(/remember_required:/i);
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
    expect(assertAgentMemoryWriteAllowed(path.join(memoryRoot, 'x.md'))).toMatch(/remember_required:/i);
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
    expect(assertAgentMemoryShellCommandAllowed('node scripts/verify_memory_seed.cjs')).toMatch(/remember_required:/i);
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

  it('type:user 无空格或带引号也能识别并重定向', () => {
    const workDir = path.resolve('D:/proj');
    process.env.ICE_DATA_DIR = path.join(workDir, 'data');
    process.env.ICE_MEMORY_DIR = path.join(workDir, 'data/memory-files');
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'data/user-memory');

    const compact = resolveMemoryWritePath(
      'memory-files/user_compact.md',
      workDir,
      '---\ntype:user\nname: t\n---\nbody',
    );
    expect(compact).toBe(path.join(workDir, 'data/user-memory/user_compact.md'));

    const quoted = resolveMemoryWritePath(
      'memory-files/user_quoted.md',
      workDir,
      '---\ntype: "user"\nname: t\n---\nbody',
    );
    expect(quoted).toBe(path.join(workDir, 'data/user-memory/user_quoted.md'));

    delete process.env.ICE_DATA_DIR;
    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('user_ 前缀且无项目标签时强制进 user-memory；type:project 不迁', () => {
    const workDir = path.resolve('D:/proj');
    process.env.ICE_MEMORY_DIR = path.join(workDir, 'data/memory-files');
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'data/user-memory');

    expect(shouldForceUserMemoryLocation(
      path.join(workDir, 'data/memory-files/user_hygiene_cleanup.md'),
      '---\nname: hygiene\n---\n零残留',
    )).toBe(true);
    expect(resolveMemoryWritePath(
      'memory-files/user_hygiene_cleanup.md',
      workDir,
      '---\nname: hygiene\n---\n零残留',
    )).toBe(path.join(workDir, 'data/user-memory/user_hygiene_cleanup.md'));

    expect(shouldForceUserMemoryLocation(
      path.join(workDir, 'data/memory-files/user-auth-overview.md'),
      '---\ntype: project\ntags: project:icecoder\n---\nauth',
    )).toBe(false);
    expect(shouldForceUserMemoryLocation(
      path.join(workDir, 'data/memory-files/user-auth-overview.md'),
      '---\nname: auth\n---\nauth flow',
    )).toBe(false);
    expect(shouldForceUserMemoryLocation(
      path.join(workDir, 'data/memory-files/user_guide.md'),
      '---\nname: guide\n---\nhow to use',
    )).toBe(false);
    expect(shouldForceUserMemoryLocation(
      path.join(workDir, 'data/memory-files/user_guide.md'),
      '---\ntype: user\n---\nhabit',
    )).toBe(true);

    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('拒绝把无关用户习惯写进同一文件', () => {
    expect(shouldRejectMixedTopicMemory(
      '零残留：删除 debug-*.mjs\n绝对不要修改 ProjectSettings/ProjectVersion.txt',
      'user',
    )).toBe('mixed_user_topics');
    expect(shouldRejectMixedTopicMemory(
      'git commit message 必须用中文，并且记得 push',
      'user',
    )).toBeNull();
    expect(shouldRejectMixedTopicMemory(
      'git commit message 必须用中文。命令必须使用 pwsh.exe。',
      'user',
    )).toBe('mixed_user_topics');
    expect(shouldRejectMixedTopicMemory(
      '必须使用 pwsh.exe，不要用旧版 powershell',
      'user',
    )).toBeNull();
  });

  it('remember 门控按 sessionId 隔离，互不覆盖', () => {
    const memoryRoot = path.join(path.resolve('D:/proj'), 'data/memory-files');
    process.env.ICE_MEMORY_DIR = memoryRoot;
    process.env.ICE_USER_MEMORY_DIR = path.join(path.resolve('D:/proj'), 'data/user-memory');
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，commit 用中文'), 'sess-a');
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '帮我装 mysql'), 'sess-b');

    expect(assertAgentMemoryWriteAllowed(path.join(memoryRoot, 'a.md'), { sessionId: 'sess-a' })).toBeNull();
    expect(assertAgentMemoryWriteAllowed(path.join(memoryRoot, 'b.md'), { sessionId: 'sess-b' })).toMatch(/remember_required/i);

    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('shell 成功写入占用会话配额；能抽出文件名时允许回写同一文件', () => {
    const cap = createLongTermMemoryWriteCap();
    registerLongTermMemoryWriteCap(cap);
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，commit 用中文'));
    const memoryRoot = path.join(path.resolve('D:/proj'), 'data/memory-files');
    const userRoot = path.join(path.resolve('D:/proj'), 'data/user-memory');
    process.env.ICE_MEMORY_DIR = memoryRoot;
    process.env.ICE_USER_MEMORY_DIR = userRoot;

    expect(extractMemoryWriteBasenamesFromShellCommand('echo x > user-memory/from_shell.md')).toEqual([
      'from_shell.md',
    ]);
    recordShellMemoryWriteSuccess(undefined, 'echo x > user-memory/from_shell.md');
    expect(assertAgentMemoryWriteAllowed(path.join(userRoot, 'from_shell.md'))).toBeNull();
    expect(assertAgentMemoryWriteAllowed(path.join(userRoot, 'other.md'))).toMatch(/session_memory_write_cap/i);

    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('未注册 cap 时 shell 成功不新建配额', () => {
    registerLongTermMemoryWriteCap(null);
    recordShellMemoryWriteSuccess('orphan-session', 'echo x > user-memory/from_shell.md');
    const cap = createLongTermMemoryWriteCap();
    registerLongTermMemoryWriteCap(cap);
    const memoryRoot = path.join(path.resolve('D:/proj'), 'data/memory-files');
    process.env.ICE_MEMORY_DIR = memoryRoot;
    process.env.ICE_USER_MEMORY_DIR = path.join(path.resolve('D:/proj'), 'data/user-memory');
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    expect(assertAgentMemoryWriteAllowed(path.join(memoryRoot, 'next.md'))).toBeNull();
    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('会话写配额：同文件更新放行，不同文件拒绝；失败不占配额', () => {
    const cap = createLongTermMemoryWriteCap();
    registerLongTermMemoryWriteCap(cap);
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，commit 用中文'));
    const memoryRoot = path.join(path.resolve('D:/proj'), 'data/memory-files');
    process.env.ICE_MEMORY_DIR = memoryRoot;
    process.env.ICE_USER_MEMORY_DIR = path.join(path.resolve('D:/proj'), 'data/user-memory');

    const first = path.join(memoryRoot, 'user_a.md');
    expect(assertAgentMemoryWriteAllowed(first, { content: '---\ntype: project\n---\nok' })).toBeNull();
    recordLongTermMemoryWriteSuccess(first);
    expect(assertAgentMemoryWriteAllowed(first)).toBeNull();
    expect(assertAgentMemoryWriteAllowed(path.join(memoryRoot, 'user_b.md'))).toMatch(/session_memory_write_cap/i);

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
    registerLongTermMemoryWriteCap(null);
    resetSessionLongTermMemoryWriteCaps();
    delete process.env.ICE_MEMORY_DIR;
    delete process.env.ICE_USER_MEMORY_DIR;
    await rm(workDir, { recursive: true, force: true });
  });

  it('edit_file 记忆路径无 remember 时先于 read-before-edit 返回 remember_required', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(memoryDir, { recursive: true });
    const memFile = path.join(memoryDir, 'probe.md');
    await writeFile(memFile, '# title\n', 'utf-8');
    const { createFileTools } = await import('../../../src/tools/builtin/file-tools.js');
    const tools = createFileTools(workDir);
    const editTool = tools.find(t => t.definition.name === 'edit_file')!;
    const result = await editTool.handler({
      path: path.join('memory-files', 'probe.md'),
      search: '# title',
      replace: '# changed',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/remember_required:/);
    expect(result.error).not.toMatch(/read-before-edit/);
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
    expect(result.output).toMatch(/stored at/i);
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('append_file / patch_file 把 type:user 从 memory-files 迁到 user-memory', async () => {
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'user-memory');
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    const { writeFile, mkdir, access, readFile } = await import('node:fs/promises');
    await mkdir(memoryDir, { recursive: true });
    const { createFileTools } = await import('../../../src/tools/builtin/file-tools.js');
    const { createPatchTool } = await import('../../../src/tools/builtin/patch-tool.js');
    const { markFileRead } = await import('../../../src/tools/read-before-edit.js');
    const tools = createFileTools(workDir);
    const appendTool = tools.find(t => t.definition.name === 'append_file')!;

    const appendResult = await appendTool.handler({
      path: path.join('memory-files', 'user_append_note.md'),
      content: '---\ntype: user\ndescription: append\n---\nfrom append\n',
    });
    expect(appendResult.success).toBe(true);
    await expect(access(path.join(workDir, 'user-memory', 'user_append_note.md'))).resolves.toBeUndefined();
    await expect(access(path.join(memoryDir, 'user_append_note.md'))).rejects.toThrow();

    await writeFile(
      path.join(memoryDir, 'user_patch_note.md'),
      '---\ntype: user\ndescription: patch\n---\nkeep\n',
      'utf-8',
    );
    markFileRead(workDir, path.join('memory-files', 'user_patch_note.md'));
    const patchTool = createPatchTool(workDir);
    const patchResult = await patchTool.handler({
      path: path.join('memory-files', 'user_patch_note.md'),
      patch: '@@ -5,1 +5,2 @@\n keep\n+patched line\n',
    });
    expect(patchResult.success).toBe(true);
    await expect(access(path.join(workDir, 'user-memory', 'user_patch_note.md'))).resolves.toBeUndefined();
    await expect(access(path.join(memoryDir, 'user_patch_note.md'))).rejects.toThrow();
    expect(await readFile(path.join(workDir, 'user-memory', 'user_patch_note.md'), 'utf-8')).toContain('keep');
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('第二次写入不同长期记忆文件被会话 cap 拒绝；混写被拒且不占配额', async () => {
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'user-memory');
    const cap = createLongTermMemoryWriteCap();
    registerLongTermMemoryWriteCap(cap);
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    const { createFileTools } = await import('../../../src/tools/builtin/file-tools.js');
    const { markFileRead } = await import('../../../src/tools/read-before-edit.js');
    const tools = createFileTools(workDir);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;

    const mixed = await writeTool.handler({
      path: path.join('memory-files', 'user_mixed.md'),
      content: '---\ntype: user\n---\n零残留：删除 debug-*.mjs\n不要改 ProjectVersion.txt\n',
    });
    expect(mixed.success).toBe(false);
    expect(mixed.error).toMatch(/mixed_user_topics/);
    expect(cap.writtenBasenames.size).toBe(0);

    const first = await writeTool.handler({
      path: path.join('user-memory', 'user_work_style.md'),
      content: '---\ntype: user\n---\ngit commit 用中文\n',
    });
    expect(first.success).toBe(true);

    const second = await writeTool.handler({
      path: path.join('user-memory', 'user_other.md'),
      content: '---\ntype: user\n---\n另一个习惯\n',
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/session_memory_write_cap/);

    markFileRead(workDir, path.join('user-memory', 'user_work_style.md'));
    const update = await writeTool.handler({
      path: path.join('user-memory', 'user_work_style.md'),
      content: '---\ntype: user\n---\ngit commit 用中文，记得 push\n',
    });
    expect(update.success).toBe(true);
    delete process.env.ICE_USER_MEMORY_DIR;
  });

  it('edit_file 跟随 E6a 重定向后的 user-memory 文件', async () => {
    process.env.ICE_USER_MEMORY_DIR = path.join(workDir, 'user-memory');
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    const { createFileTools } = await import('../../../src/tools/builtin/file-tools.js');
    const { markFileRead } = await import('../../../src/tools/read-before-edit.js');
    const tools = createFileTools(workDir);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;
    const editTool = tools.find(t => t.definition.name === 'edit_file')!;
    const written = await writeTool.handler({
      path: path.join('memory-files', 'user_follow.md'),
      content: '---\ntype: user\n---\nhello\n',
    });
    expect(written.success).toBe(true);
    markFileRead(workDir, path.join('memory-files', 'user_follow.md'));
    const edited = await editTool.handler({
      path: path.join('memory-files', 'user_follow.md'),
      search: 'hello',
      replace: 'hello world',
    });
    expect(edited.success).toBe(true);
    const { readFile, access } = await import('node:fs/promises');
    expect(await readFile(path.join(workDir, 'user-memory', 'user_follow.md'), 'utf-8')).toContain('hello world');
    await expect(access(path.join(memoryDir, 'user_follow.md'))).rejects.toThrow();
    delete process.env.ICE_USER_MEMORY_DIR;
  });
});
