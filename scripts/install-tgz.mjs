#!/usr/bin/env node
/**
 * 把当前仓库打好的 tgz 装到全局。
 * `npm run build` 会先自增 patch 版本，npm 看到新版本就会覆盖旧包；
 * 仍带 --force，避免同一次 tgz 重复安装被跳过。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tgzName = `${pkg.name}-${pkg.version}.tgz`;
const tgz = path.join(root, tgzName);

export function resolveInstallArgs(tgzPath) {
  return ['install', '-g', tgzPath, '--force'];
}

function main() {
  if (!fs.existsSync(tgz)) {
    console.error(`找不到 ${tgzName}，请先运行 npm run build`);
    process.exit(1);
  }

  const args = resolveInstallArgs(tgz);
  console.log(`npm ${args.join(' ')}`);

  const result = spawnSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(result.status ?? 1);
}

const invokedAsCli = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\\/g, '/') === 'install-tgz.mjs'
  : false;
if (invokedAsCli) {
  main();
}
