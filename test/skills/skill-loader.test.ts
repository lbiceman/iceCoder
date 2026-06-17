import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectSkillRelativePaths,
  normalizeSkillFilename,
  readSkillFile,
  scanSkillFiles,
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
