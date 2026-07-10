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
const { BUNDLED_DATA_FILES } = require('../../scripts/bundled-data-files.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.resolve(__dirname, '..');
const targetRoot = path.join(desktopRoot, 'server-bundle');

const FILES_TO_COPY = [
  'dist',
  'package.json',
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

/** 从 PROD_DEPS 出发，收集 npm 扁平 node_modules 中的全部传递依赖。 */
function collectTransitiveDependencies(rootNames, nodeModulesDir) {
  const collected = new Set();
  const queue = [...rootNames];

  while (queue.length > 0) {
    const name = queue.shift();
    if (collected.has(name)) continue;
    collected.add(name);

    const pkgJsonPath = path.join(nodeModulesDir, name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }

    for (const depName of Object.keys(pkg.dependencies || {})) {
      if (!collected.has(depName)) queue.push(depName);
    }
  }

  return [...collected].sort();
}

/** Vite 已打包主 SPA；仅 pet 浮窗仍依赖这些未打包的模块。 */
const PET_STATIC_JS_FILES = [
  'pet-floating-page.js',
  'session-pet.js',
  'session-pet-palette.js',
];
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
  for (const rel of PET_STATIC_JS_FILES) {
    const src = path.join(srcPublic, 'js', rel);
    if (!fs.existsSync(src)) continue;
    copyFile(src, path.join(targetDistPublic, 'js', rel));
    log(`mergePublic js/${rel}`);
  }
  // pet-floating.html 直接引用 style.css，而它继续通过 @import 引用其余样式表；
  // 复制整个 CSS 目录以保留这条依赖链，同时不再复制主 SPA 的 40 余个原始 JS 模块。
  const cssDir = path.join(srcPublic, 'css');
  if (fs.existsSync(cssDir)) {
    copyDir(cssDir, path.join(targetDistPublic, 'css'));
    log('mergePublic css/ (pet floating dependencies)');
  }
}

function getRipgrepPlatformDependency(nodeModulesDir) {
  const pkgPath = path.join(nodeModulesDir, '@vscode', 'ripgrep', 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const expected = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    return Object.prototype.hasOwnProperty.call(pkg.optionalDependencies || {}, expected) ? expected : null;
  } catch {
    return null;
  }
}

function copyBundledDataFiles(repoRoot, targetRoot) {
  for (const rel of BUNDLED_DATA_FILES) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(targetRoot, rel);
    if (!fs.existsSync(src)) {
      log(`SKIP missing bundled ${rel}`);
      continue;
    }
    log(`copyFile ${rel}`);
    copyFile(src, dst);
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

  copyBundledDataFiles(repoRoot, targetRoot);

  mergePublicStaticExtras(repoRoot, path.join(targetRoot, 'dist', 'public'));

  // 复制生产依赖及其传递依赖（cheerio 等 ESM 包会 import 顶层 node_modules 中的子依赖）
  const repoNm = path.join(repoRoot, 'node_modules');
  const tgtNm = path.join(targetRoot, 'node_modules');
  fs.mkdirSync(tgtNm, { recursive: true });
  const ripgrepPlatformDependency = getRipgrepPlatformDependency(repoNm);
  const prodDeps = [
    ...PROD_DEPS,
    ...(ripgrepPlatformDependency ? [ripgrepPlatformDependency] : []),
  ];
  const depsToCopy = collectTransitiveDependencies(prodDeps, repoNm);
  log(`copyDeps ${depsToCopy.length} packages (roots=${prodDeps.length})`);
  let copied = 0;
  let skipped = 0;
  for (const dep of depsToCopy) {
    const src = path.join(repoNm, dep);
    const dst = path.join(tgtNm, dep);
    if (!fs.existsSync(src)) {
      log(`SKIP dep ${dep} (not installed)`);
      skipped += 1;
      continue;
    }
    copyDir(src, dst);
    copied += 1;
  }
  log(`copyDeps done: copied=${copied} skipped=${skipped}`);

  // 写一个 server-bundle 专属 package.json，type=commonjs 让 Node 顺利 require dist
  const srcPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const bundlePkg = {
    name: 'icecoder-server-bundle',
    version: srcPkg.version,
    description: 'iceCoder server bundle for Electron desktop',
    main: 'dist/index.js',
    type: 'module',
    dependencies: Object.fromEntries(
      prodDeps.map((d) => [d, (srcPkg.dependencies || {})[d] || '*']),
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

  const verify = spawnSync(
    process.execPath,
    ['-e', "import('cheerio').then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); })"],
    { cwd: targetRoot, env: process.env, stdio: 'pipe' },
  );
  if (verify.status !== 0) {
    const err = (verify.stderr || '').toString().trim();
    throw new Error(`server-bundle dependency verify failed${err ? `: ${err}` : ''}`);
  }
  log('verify: cheerio import ok');
  log('done.');
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
