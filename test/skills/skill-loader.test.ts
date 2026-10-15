import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SkillWriteError,
  collectSkillRelativePaths,
  composeSkillDocument,
  createSkillFile,
  normalizeSkillFilename,
  normalizeSkillFolderSegment,
  normalizeSkillLeafName,
  readSkillFile,
  scanSkillFiles,
  updateSkillContent,
} from '../../src/skills/skill-loader.js';

describe('collectSkillRelativePaths / scanSkillFiles', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('注册根目录 .md 与一级子目录内的 .md', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ice-skill-scan-'));
    await writeFile(path.join(tmpDir, '创建技能.md'), '---\nname: 创建技能\n---\n', 'utf-8');
    await mkdir(path.join(tmpDir, 'openClaude'), { recursive: true });
    await writeFile(path.join(tmpDir, 'openClaude', 'skll.md'), '---\nname: 打开\n---\n', 'utf-8');
    await writeFile(path.join(tmpDir, 'openClaude', 'open.js'), 'console.log(1)', 'utf-8');
    await mkdir(path.join(tmpDir, 'deep'), { recursive: true });
    await mkdir(path.join(tmpDir, 'deep', 'nested'), { recursive: true });
    await writeFile(path.join(tmpDir, 'deep', 'nested', 'x.md'), '---\nname: x\n---\n', 'utf-8');

    const paths = await collectSkillRelativePaths(tmpDir);
    expect(paths.sort()).toEqual(['openClaude/skll.md', '创建技能.md'].sort());

    const skills = await scanSkillFiles(tmpDir);
    expect(skills.map((s) => s.filename).sort()).toEqual(['openClaude/skll.md', '创建技能.md'].sort());
  });

  it('跳过技能文件夹内的 README.md', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ice-skill-readme-'));
    await mkdir(path.join(tmpDir, 'e2eTest'), { recursive: true });
    await writeFile(path.join(tmpDir, 'e2eTest', 'skill.md'), '---\nname: 端到端测试\n---\n', 'utf-8');
    await writeFile(path.join(tmpDir, 'e2eTest', 'README.md'), '# docs\n', 'utf-8');
    await writeFile(path.join(tmpDir, 'e2eTest', 'readme.md'), '# lower\n', 'utf-8');

    const paths = await collectSkillRelativePaths(tmpDir);
    expect(paths).toEqual(['e2eTest/skill.md']);
  });

  it('可按一级子路径读取技能', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ice-skill-read-'));
    await mkdir(path.join(tmpDir, 'openClaude'), { recursive: true });
    await writeFile(path.join(tmpDir, 'openClaude', 'skll.md'), '---\nname: 打开claudeCode\n---\nbody', 'utf-8');

    const found = await readSkillFile(tmpDir, 'openClaude/skll.md');
    expect(found?.meta.name).toBe('打开claudeCode');
    expect(found?.meta.filename).toBe('openClaude/skll.md');
  });
});

describe('normalizeSkillFilename', () => {
  it('保留一级子目录路径', () => {
    expect(normalizeSkillFilename('openClaude/skll.md')).toBe('openClaude/skll.md');
    expect(normalizeSkillFilename('#openClaude/skll')).toBe('openClaude/skll.md');
    expect(normalizeSkillFilename('创建技能')).toBe('创建技能.md');
  });

  it('拒绝更深层路径', () => {
    expect(normalizeSkillFilename('a/b/c.md')).toBe('');
    expect(normalizeSkillFilename('../x.md')).toBe('');
  });
});

describe('createSkillFile / updateSkillContent', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('简单技能写入根目录或一级文件夹，并生成 frontmatter', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ice-skill-write-'));
    const root = await createSkillFile(tmpDir, {
      folder: '',
      name: '登录考试',
      content: '先连接服务器，再输入验证码。',
    });
    expect(root.filename).toBe('登录考试.md');
    expect(root.meta.name).toBe('登录考试');
    expect(root.meta.description).toBe('先连接服务器，再输入验证码。');
    expect(root.content).toContain('name: 登录考试');

    const nested = await createSkillFile(tmpDir, {
      folder: 'connectWeChat',
      name: '连接微信.md',
      content: '# 步骤\n打开客户端',
    });
    expect(nested.filename).toBe('connectWeChat/连接微信.md');
    const onDisk = await readFile(path.join(tmpDir, 'connectWeChat', '连接微信.md'), 'utf-8');
    expect(onDisk).toContain('description: 步骤');
    expect(onDisk).toContain('打开客户端');
  });

  it('拒绝路径穿越、readme 和重名', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ice-skill-write-'));
    expect(() => normalizeSkillFolderSegment('../secrets')).toThrow(SkillWriteError);
    expect(() => normalizeSkillFolderSegment('a/b')).toThrow(SkillWriteError);
    expect(() => normalizeSkillLeafName('readme')).toThrow(SkillWriteError);
    expect(() => normalizeSkillLeafName('')).toThrow(SkillWriteError);

    await createSkillFile(tmpDir, { name: '已有', content: '正文' });
    await expect(createSkillFile(tmpDir, { name: '已有', content: '另一份' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('更新已有技能内容，不存在时 404', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ice-skill-write-'));
    await createSkillFile(tmpDir, { folder: 'box', name: '简单', content: '旧内容' });
    const updated = await updateSkillContent(tmpDir, 'box/简单.md', '---\nname: 简单\n---\n新内容\n');
    expect(updated.content).toContain('新内容');
    expect(updated.meta.name).toBe('简单');
    await expect(updateSkillContent(tmpDir, 'missing.md', 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('已带 frontmatter 的内容原样保存', () => {
    const text = composeSkillDocument('忽略', '---\nname: 自带\n---\n正文');
    expect(text.startsWith('---\nname: 自带')).toBe(true);
    expect(text).not.toContain('name: 忽略');
  });
});
