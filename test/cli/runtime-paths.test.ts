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
    'ICE_DEFAULT_WORK_DIR',
    'ICE_SHELL_IDENTITY_DIR',
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
    expect(paths.mcpConfigPath).toBe(path.resolve('.iceCoder/mcp.json'));
  });

  it('uses ~/.iceCoder/mcp.json in production', async () => {
    process.env.NODE_ENV = 'production';
    const { resolveDataPaths } = await loadPathsModule();
    const expectedRoot = path.join(os.homedir(), '.iceCoder');
    const paths = await resolveDataPaths();
    expect(paths.mcpConfigPath).toBe(path.join(expectedRoot, 'mcp.json'));
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

  it('production 读取共享壳目录里的 data-directory.json', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { writePersistedDataDirectory } = await import('../../src/runtime/shell-identity.js');
    const identity = await mkdtemp(path.join(os.tmpdir(), 'ice-id-'));
    const custom = await mkdtemp(path.join(os.tmpdir(), 'ice-custom-root-'));
    process.env.NODE_ENV = 'production';
    process.env.ICE_SHELL_IDENTITY_DIR = identity;
    writePersistedDataDirectory(custom);
    try {
      const { applyRuntimeDataEnvDefaults, getRuntimeDataDir, resolveDataPaths } = await loadPathsModule();
      applyRuntimeDataEnvDefaults();
      expect(getRuntimeDataDir()).toBe(path.resolve(custom));
      const paths = await resolveDataPaths();
      expect(paths.mcpConfigPath).toBe(path.join(path.resolve(custom), 'mcp.json'));
    } finally {
      await rm(identity, { recursive: true, force: true });
      await rm(custom, { recursive: true, force: true });
    }
  });

  it('respects explicit ICE_DATA_DIR override', async () => {
    process.env.NODE_ENV = 'production';
    const custom = path.join(os.tmpdir(), 'ice-custom-data');
    process.env.ICE_DATA_DIR = custom;
    const { getRuntimeDataDir, resolveDataPaths } = await loadPathsModule();
    expect(getRuntimeDataDir()).toBe(path.resolve(custom));
    const paths = await resolveDataPaths();
    expect(paths.sessionsDir).toBe(path.join(path.resolve(custom), 'sessions'));
    expect(paths.mcpConfigPath).toBe(path.join(path.resolve(custom), 'mcp.json'));
  });

  it('inline images: dev and prod under runtime data dir (imagesCache)', async () => {
    process.env.NODE_ENV = 'development';
    const devMod = await loadPathsModule();
    expect(devMod.getImagesCacheSessionDir('s1')).toBe(
      path.resolve('data', 'imagesCache', 's1'),
    );

    process.env.NODE_ENV = 'production';
    delete process.env.ICE_DATA_DIR;
    const prodMod = await loadPathsModule();
    const dataRoot = prodMod.getRuntimeDataDir();
    expect(prodMod.getImagesCacheSessionDir('s1')).toBe(
      path.join(dataRoot, 'imagesCache', 's1'),
    );
    expect(dataRoot).toBe(path.join(os.homedir(), '.iceCoder'));
    expect(prodMod.getUserCacheDir()).not.toBe(dataRoot);
  });
});
