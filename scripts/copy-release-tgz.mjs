#!/usr/bin/env node
/**
 * 把 npm pack 产物复制到 releases/npm/ice-coder.tgz（固定文件名，供 README 下载）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_TGZ_REL = path.join('releases', 'npm', 'ice-coder.tgz');

export function resolvePackedTgzPath(repoRoot, pkg) {
  return path.join(repoRoot, `${pkg.name}-${pkg.version}.tgz`);
}

export function resolveReleaseTgzPath(repoRoot) {
  return path.join(repoRoot, RELEASE_TGZ_REL);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const src = resolvePackedTgzPath(root, pkg);
  const dest = resolveReleaseTgzPath(root);
  if (!fs.existsSync(src)) {
    console.error(`[copy-release-tgz] 未找到构建产物: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-release-tgz] ${dest}`);
}

const invokedAsCli = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\\/g, '/') === 'copy-release-tgz.mjs'
  : false;
if (invokedAsCli) {
  main();
}
