/**
 * 一次性验证开发/生产数据路径解析（不启动服务）。
 * 用法: tsx scripts/verify-runtime-paths.ts
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

async function verify(label: string, nodeEnv: string | undefined): Promise<boolean> {
  for (const key of [
    'NODE_ENV',
    'ICE_DATA_DIR',
    'ICE_CONFIG_PATH',
    'ICE_SESSIONS_DIR',
    'ICE_MEMORY_DIR',
    'ICE_MCP_CONFIG_PATH',
  ]) {
    delete process.env[key];
  }
  if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;

  const mod = await import('../src/cli/paths.js');
  mod.applyRuntimeDataEnvDefaults();
  const dataDir = mod.getRuntimeDataDir();
  const paths = await mod.resolveDataPaths();

  const expectedRoot =
    nodeEnv === 'production'
      ? path.join(os.homedir(), '.iceCoder')
      : path.resolve('data');

  const expectedMcp =
    nodeEnv === 'production'
      ? path.join(os.homedir(), '.iceCoder', 'mcp.json')
      : path.resolve('.iceCoder/mcp.json');

  const ok =
    path.resolve(dataDir) === path.resolve(expectedRoot)
    && paths.configPath === path.join(path.resolve(expectedRoot), 'config.json')
    && paths.sessionsDir === path.join(path.resolve(expectedRoot), 'sessions')
    && paths.mcpConfigPath === expectedMcp;

  console.log(`\n[${label}] NODE_ENV=${nodeEnv ?? '(unset)'}`);
  console.log('  dataDir     ', dataDir);
  console.log('  configPath  ', paths.configPath);
  console.log('  sessionsDir ', paths.sessionsDir);
  console.log('  memoryDir   ', paths.memoryFilesDir);
  console.log('  mcpConfig   ', paths.mcpConfigPath);
  console.log('  expected    ', expectedRoot);
  console.log('  =>', ok ? 'PASS' : 'FAIL');
  return ok;
}

async function verifyDevConfigReadable(): Promise<boolean> {
  const configPath = path.resolve('data/config.json');
  try {
    await fs.access(configPath);
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { providers?: unknown[] };
    const ok = Array.isArray(parsed.providers) && parsed.providers.length > 0;
    console.log(`\n[dev config] ${configPath} readable, providers=${parsed.providers?.length ?? 0} => ${ok ? 'PASS' : 'FAIL'}`);
    return ok;
  } catch (err) {
    console.log(`\n[dev config] ${configPath} => FAIL (${err instanceof Error ? err.message : err})`);
    return false;
  }
}

const results: boolean[] = [];
results.push(await verify('development', 'development'));
results.push(await verify('dev-unset', undefined));
results.push(await verify('production', 'production'));
results.push(await verifyDevConfigReadable());

if (results.every(Boolean)) {
  console.log('\nAll runtime path checks PASSED.');
  process.exit(0);
}
console.error('\nSome runtime path checks FAILED.');
process.exit(1);
