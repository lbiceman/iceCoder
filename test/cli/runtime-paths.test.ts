import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

describe('runtime data paths', () => {
  const envBackup: Record<string, string | undefined> = {};
  const keys = [
    'NODE_ENV',
    'ICE_DATA_DIR',
    'ICE_CONFIG_PATH',
    'ICE_SESSIONS_DIR',
    'ICE_MEMORY_DIR',
    'ICE_OUTPUT_DIR',
    'ICE_USER_MEMORY_DIR',
    'ICE_MCP_CONFIG_PATH',
  ];

  beforeEach(() => {
    for (const key of keys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
  });

  async function loadPathsModule() {
    return import('../../src/cli/paths.js');
  }

  it('uses project data/ in development', async () => {
    process.env.NODE_ENV = 'development';
    const { getRuntimeDataDir, resolveDataPaths } = await loadPathsModule();
    expect(getRuntimeDataDir()).toBe(path.resolve('data'));
    const paths = await resolveDataPaths();
    expect(paths.configPath).toBe(path.resolve('data/config.json'));
    expect(paths.sessionsDir).toBe(path.resolve('data/sessions'));
    expect(paths.mcpConfigPath).toBe(path.resolve('data/mcp.json'));
  });

  it('uses ~/.iceCoder in production', async () => {
    process.env.NODE_ENV = 'production';
    const { getRuntimeDataDir, resolveDataPaths } = await loadPathsModule();
    const expectedRoot = path.join(os.homedir(), '.iceCoder');
    expect(getRuntimeDataDir()).toBe(expectedRoot);
    const paths = await resolveDataPaths();
    expect(paths.configPath).toBe(path.join(expectedRoot, 'config.json'));
    expect(paths.memoryFilesDir).toBe(path.join(expectedRoot, 'memory-files'));
  });

  it('respects explicit ICE_DATA_DIR override', async () => {
    process.env.NODE_ENV = 'production';
    const custom = path.join(os.tmpdir(), 'ice-custom-data');
    process.env.ICE_DATA_DIR = custom;
    const { getRuntimeDataDir, resolveDataPaths } = await loadPathsModule();
    expect(getRuntimeDataDir()).toBe(path.resolve(custom));
    const paths = await resolveDataPaths();
    expect(paths.sessionsDir).toBe(path.join(path.resolve(custom), 'sessions'));
  });

  it('inline images: dev under data/, prod under user cache', async () => {
    process.env.NODE_ENV = 'development';
    const devMod = await loadPathsModule();
    expect(devMod.getImagesCacheSessionDir('s1')).toBe(
      path.resolve('data', 'imagesCache', 's1'),
    );

    process.env.NODE_ENV = 'production';
    delete process.env.ICE_DATA_DIR;
    const prodMod = await loadPathsModule();
    const cacheRoot = prodMod.getUserCacheDir();
    expect(prodMod.getImagesCacheSessionDir('s1')).toBe(
      path.join(cacheRoot, 'imagesCache', 's1'),
    );
    expect(cacheRoot).not.toBe(path.join(os.homedir(), '.iceCoder'));
  });
});
