#!/usr/bin/env node
/**
 * npm pack 前把 package.json 的 patch 版本 +1。
 * 这样 `npm install -g ./ice-coder-<version>.tgz` 会像 Claude Code / OpenCode 一样
 * 看到新版本并覆盖全局旧包（不必先 uninstall）。
 *
 * CI 默认不自增（避免评测/流水线把仓库版本改脏）。本地可用 ICE_BUMP_VERSION=0 关闭。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function bumpPatch(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`无法自增版本号: ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function shouldBumpVersion(env = process.env) {
  const flag = env.ICE_BUMP_VERSION?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  const ci = env.CI?.trim().toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return false;
  return true;
}

export function patchJsonVersionField(text, oldVersion, newVersion, limit = 1) {
  const from = `"version": "${oldVersion}"`;
  const to = `"version": "${newVersion}"`;
  let out = text;
  let start = 0;
  for (let i = 0; i < limit; i++) {
    const idx = out.indexOf(from, start);
    if (idx === -1) break;
    out = `${out.slice(0, idx)}${to}${out.slice(idx + from.length)}`;
    start = idx + to.length;
  }
  return out;
}

export function listPackTarballs(names, pkgName = 'ice-coder') {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}-\\d+\\.\\d+\\.\\d+.*\\.tgz$`);
  return names.filter((name) => re.test(name));
}

function main() {
  if (!shouldBumpVersion()) {
    console.log('[bump-pack-version] skip（CI 或 ICE_BUMP_VERSION=0）');
    return;
  }

  const pkgPath = path.join(root, 'package.json');
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText);
  const oldVersion = String(pkg.version ?? '');
  const newVersion = bumpPatch(oldVersion);
  fs.writeFileSync(pkgPath, patchJsonVersionField(pkgText, oldVersion, newVersion, 1), 'utf8');

  const lockPath = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lockText = fs.readFileSync(lockPath, 'utf8');
    fs.writeFileSync(lockPath, patchJsonVersionField(lockText, oldVersion, newVersion, 2), 'utf8');
  }

  for (const name of listPackTarballs(fs.readdirSync(root), pkg.name)) {
    fs.unlinkSync(path.join(root, name));
  }

  console.log(`[bump-pack-version] ${oldVersion} -> ${newVersion}`);
}

const invokedAsCli = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\\/g, '/') === 'bump-pack-version.mjs'
  : false;
if (invokedAsCli) {
  main();
}
