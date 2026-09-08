#!/usr/bin/env node
/**
 * 禁止 package.json 把本包自己写成依赖。
 * 在仓库里执行 `npm install ./releases/npm/ice-coder.tgz` 会写入
 * `"ice-coder": "file:releases/npm/ice-coder.tgz"`，打进 tgz 后
 * `npm install -g ./ice-coder.tgz` 会去全局目录找这个文件并 ENOENT。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

export function findSelfDependency(pkg) {
  const name = pkg?.name;
  if (!name || typeof name !== 'string') return null;
  for (const field of DEP_FIELDS) {
    const spec = pkg[field]?.[name];
    if (spec != null) return { field, spec };
  }
  return null;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const hit = findSelfDependency(pkg);
  if (!hit) return;
  console.error(
    `[assert-no-self-dep] ${hit.field} 不能包含本包自身（${pkg.name}: ${hit.spec}）。` +
    '请从 package.json 删除该条目后重新 npm pack。',
  );
  process.exit(1);
}

const invokedAsCli = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\\/g, '/') === 'assert-no-self-dep.mjs'
  : false;
if (invokedAsCli) {
  main();
}
