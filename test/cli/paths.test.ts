import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_DATA_DIR,
  USER_DATA_DIR,
  applyRuntimeDataEnvDefaults,
  ensureDefaultSkillFiles,
  getMcpCacheDir,
  getRuntimeDataDir,
  isPackagedCliEntry,
  resolvePackagedDataExamplePath,
  usesUserDataRoot,
} from '../../src/cli/paths.js';

describe('usesUserDataRoot / data dir', () => {
  const env = process.env;
  const argv1 = process.argv[1];

  afterEach(() => {
    process.env = { ...env };
    process.argv[1] = argv1;
    delete process.env.ICE_DATA_DIR;
    delete process.env.ICE_SESSIONS_DIR;
    delete process.env.ICE_CONFIG_PATH;
    delete process.env.ICE_CACHE_ROOT;
  });

  it('全局安装入口 → ~/.iceCoder', () => {
    delete process.env.NODE_ENV;
    delete process.env.ICE_DATA_DIR;
    process.argv[1] =
      'C:/Users/me/AppData/Roaming/npm/node_modules/ice-coder/dist/cli/index.js';
    expect(isPackagedCliEntry()).toBe(true);
    expect(usesUserDataRoot()).toBe(true);
    applyRuntimeDataEnvDefaults();
    expect(getRuntimeDataDir()).toBe(USER_DATA_DIR);
  });

  it('源码 tsx 入口 → 本地 iceCoderCache', () => {
    delete process.env.NODE_ENV;
    delete process.env.ICE_DATA_DIR;
    delete process.env.ICE_CACHE_ROOT;
    process.argv[1] = 'D:/work/self/iceCoder/src/cli/index.ts';
    expect(isPackagedCliEntry()).toBe(false);
    expect(usesUserDataRoot()).toBe(false);
    applyRuntimeDataEnvDefaults();
    expect(getRuntimeDataDir()).toBe(LOCAL_DATA_DIR);
  });

  it('ICE_CACHE_ROOT 覆盖源码开发数据根', () => {
    delete process.env.NODE_ENV;
    delete process.env.ICE_DATA_DIR;
    process.env.ICE_CACHE_ROOT = 'D:/custom/ice-cache';
    process.argv[1] = 'D:/work/self/iceCoder/src/cli/index.ts';
    applyRuntimeDataEnvDefaults();
    expect(getRuntimeDataDir()).toBe(path.resolve('D:/custom/ice-cache'));
  });

  it('NODE_ENV=production → ~/.iceCoder', () => {
    process.env.NODE_ENV = 'production';
    process.argv[1] = 'D:/work/self/iceCoder/dist/cli/index.js';
    applyRuntimeDataEnvDefaults();
    expect(getRuntimeDataDir()).toBe(USER_DATA_DIR);
  });
});

describe('getMcpCacheDir', () => {
  const env = process.env;
  const argv1 = process.argv[1];

  afterEach(() => {
    process.env = { ...env };
    process.argv[1] = argv1;
    delete process.env.ICE_DATA_DIR;
    delete process.env.ICE_MCP_CACHE_DIR;
    delete process.env.ICE_CACHE_ROOT;
    delete process.env.NODE_ENV;
  });

  it('开发环境 → iceCoderCache/mcpCache', () => {
    delete process.env.ICE_DATA_DIR;
    delete process.env.NODE_ENV;
    process.argv[1] = 'D:/work/self/iceCoder/src/cli/index.ts';
    applyRuntimeDataEnvDefaults();
    expect(getMcpCacheDir()).toBe(path.join(LOCAL_DATA_DIR, 'mcpCache'));
  });

  it('生产环境 → ~/.iceCoder/mcpCache', () => {
    process.env.NODE_ENV = 'production';
    process.argv[1] = 'D:/work/self/iceCoder/dist/cli/index.js';
    applyRuntimeDataEnvDefaults();
    expect(getMcpCacheDir()).toBe(path.join(USER_DATA_DIR, 'mcpCache'));
  });

  it('ICE_MCP_CACHE_DIR 可覆盖默认路径', () => {
    process.env.ICE_MCP_CACHE_DIR = 'D:/custom/mcpCache';
    expect(getMcpCacheDir()).toBe(path.resolve('D:/custom/mcpCache'));
  });
});

describe('ensureDefaultSkillFiles', () => {
  it('从包内示例写入默认技能', async () => {
    const bundled = resolvePackagedDataExamplePath('skills/创建技能.md');
    expect(bundled).toContain(`${path.sep}skills${path.sep}`);

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ice-skills-'));
    try {
      const skillsDir = path.join(tmp, 'skills');
      await ensureDefaultSkillFiles(skillsDir);
      const createSkill = await readFile(path.join(skillsDir, '创建技能.md'), 'utf-8');
      expect(createSkill).toContain('name: 创建技能');
      expect(createSkill).toContain('ICE_SKILLS_DIR');
      const createAgent = await readFile(path.join(skillsDir, '创建Agent.md'), 'utf-8');
      expect(createAgent).toContain('name: 创建Agent');
      expect(createAgent).toContain('ICE_AGENTS_DIR');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('已存在的技能文件不会被覆盖', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ice-skills-skip-'));
    try {
      const skillsDir = path.join(tmp, 'skills');
      const target = path.join(skillsDir, '创建技能.md');
      const agentSkill = path.join(skillsDir, '创建Agent.md');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(target, 'custom\n', 'utf-8');
      await writeFile(agentSkill, 'custom-agent\n', 'utf-8');
      await ensureDefaultSkillFiles(skillsDir);
      expect(await readFile(target, 'utf-8')).toBe('custom\n');
      expect(await readFile(agentSkill, 'utf-8')).toBe('custom-agent\n');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
