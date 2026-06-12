import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_DATA_DIR,
  USER_DATA_DIR,
  applyRuntimeDataEnvDefaults,
  ensureSupervisorConfigFile,
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

  it('源码 tsx 入口 → 项目 data/', () => {
    delete process.env.NODE_ENV;
    delete process.env.ICE_DATA_DIR;
    process.argv[1] = 'D:/work/self/iceCoder/src/cli/index.ts';
    expect(isPackagedCliEntry()).toBe(false);
    expect(usesUserDataRoot()).toBe(false);
    applyRuntimeDataEnvDefaults();
    expect(getRuntimeDataDir()).toBe(LOCAL_DATA_DIR);
  });

  it('NODE_ENV=production → ~/.iceCoder', () => {
    process.env.NODE_ENV = 'production';
    process.argv[1] = 'D:/work/self/iceCoder/dist/cli/index.js';
    applyRuntimeDataEnvDefaults();
    expect(getRuntimeDataDir()).toBe(USER_DATA_DIR);
  });
});

describe('ensureSupervisorConfigFile', () => {
  it('从包内示例写入 dataDir/supervisor-config.json', async () => {
    const bundled = resolvePackagedDataExamplePath('supervisor-config.example.json');
    expect(bundled).toContain('supervisor-config.example.json');

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ice-supervisor-'));
    try {
      await ensureSupervisorConfigFile(tmp);
      const target = path.join(tmp, 'supervisor-config.json');
      const raw = await readFile(target, 'utf-8');
      const parsed = JSON.parse(raw) as { mode?: string; eventTimeline?: { persistPath?: string } };
      expect(parsed.mode).toBe('adaptive');
      expect(parsed.eventTimeline?.persistPath).toBe('runtime/supervisor-events.jsonl');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
