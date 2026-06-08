#!/usr/bin/env node
/**
 * copy-server-artifacts.cjs
 * 把仓库已编译的 iceCoder server 产物复制到 desktop/server-bundle/，
 * 并以环境变量指引 Node 解析打包后的 node_modules。
 *
 * 入口检查：复制后可用 ELECTRON_RUN_AS_NODE=1 node dist/index.js 启动。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.resolve(__dirname, '..');
const targetRoot = path.join(desktopRoot, 'server-bundle');

const FILES_TO_COPY = [
  'dist',
  'package.json',
  'data',
];

const PROD_DEPS = [
  '@vscode/ripgrep',
  'cheerio',
  'domhandler',
  'express',
  'jszip',
  'multer',
  'officeparser',
  'openai',
  'qrcode',
  'uuid',
  'word-extractor',
  'ws',
  'xml2js',
];

function log(msg) {
  process.stdout.write(`[copy-server-artifacts] ${msg}\n`);
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/** Vite 只产出 SPA 入口；pet-floating 等仍依赖 src/public 原始 js/css。 */
const PUBLIC_STATIC_DIRS = ['js', 'css'];
const PUBLIC_STATIC_FILES = ['pet-floating.html', 'favicon.svg'];

function mergePublicStaticExtras(repoRoot, targetDistPublic) {
  const srcPublic = path.join(repoRoot, 'src', 'public');
  if (!fs.existsSync(srcPublic)) return;
  fs.mkdirSync(targetDistPublic, { recursive: true });
  for (const rel of PUBLIC_STATIC_FILES) {
    const src = path.join(srcPublic, rel);
    if (!fs.existsSync(src)) continue;
    copyFile(src, path.join(targetDistPublic, rel));
    log(`mergePublic ${rel}`);
  }
  for (const rel of PUBLIC_STATIC_DIRS) {
    const src = path.join(srcPublic, rel);
    if (!fs.existsSync(src)) continue;
    copyDir(src, path.join(targetDistPublic, rel));
    log(`mergePublic ${rel}/`);
  }
}

function main() {
  log(`repoRoot  = ${repoRoot}`);
  log(`target    = ${targetRoot}`);

  rmrf(targetRoot);
  fs.mkdirSync(targetRoot, { recursive: true });

  for (const rel of FILES_TO_COPY) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(targetRoot, rel);
    if (!fs.existsSync(src)) {
      log(`SKIP missing ${rel}`);
      continue;
    }
    if (fs.statSync(src).isDirectory()) {
      log(`copyDir  ${rel}/`);
      copyDir(src, dst);
    } else {
      log(`copyFile ${rel}`);
      copyFile(src, dst);
    }
  }

  mergePublicStaticExtras(repoRoot, path.join(targetRoot, 'dist', 'public'));

  // 复制生产依赖子集 node_modules
  const repoNm = path.join(repoRoot, 'node_modules');
  const tgtNm = path.join(targetRoot, 'node_modules');
  fs.mkdirSync(tgtNm, { recursive: true });
  for (const dep of PROD_DEPS) {
    const src = path.join(repoNm, dep);
    const dst = path.join(tgtNm, dep);
    if (!fs.existsSync(src)) {
      log(`SKIP dep ${dep} (not installed)`);
      continue;
    }
    log(`copyDep  ${dep}`);
    copyDir(src, dst);
  }

  // 写一个 server-bundle 专属 package.json，type=commonjs 让 Node 顺利 require dist
  const srcPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const bundlePkg = {
    name: 'icecoder-server-bundle',
    version: srcPkg.version,
    description: 'iceCoder server bundle for Electron desktop',
    main: 'dist/index.js',
    type: 'module',
    dependencies: Object.fromEntries(
      PROD_DEPS.map((d) => [d, (srcPkg.dependencies || {})[d] || '*']),
    ),
  };
  fs.writeFileSync(
    path.join(targetRoot, 'package.json'),
    JSON.stringify(bundlePkg, null, 2),
  );

  // 写一个 server 启动入口 wrapper，便于主进程 spawn 调用
  // （实际启动仍走 dist/index.js；此处仅供文档/调试用）
  fs.writeFileSync(
    path.join(targetRoot, 'README.txt'),
    [
      'iceCoder server bundle',
      '=======================',
      'Main entry: dist/index.js',
      'Run directly: node dist/index.js',
      'Run as Electron Node: ELECTRON_RUN_AS_NODE=1 node dist/index.js',
      '',
    ].join('\n'),
  );

  log('done.');
  log('verify:   node -e "require(\'./server-bundle/dist/index.js\')" (must not throw)');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[copy-server-artifacts] FAILED: ${err && err.stack || err}\n`);
    process.exit(1);
  }
}

module.exports = { main };
