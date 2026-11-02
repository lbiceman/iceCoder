#!/usr/bin/env node
/**
 * prune-bundle.cjs — 安装包瘦身（A+B+C）
 *
 * A  删除运行时不加载的编译垃圾：.pdb .obj .iobj .ipdb .tlog
 * B  删除非本次目标架构的 node-pty prebuilds，以及 .map / .ts 源码 / 非许可证 .md
 *    保留 .d.ts、LICENSE/README 类文档，以及 data/（system-prompt、技能模板）
 * C  Electron locales 只留 zh-CN 与 en-US
 *    另外去掉 officeparser 未启用的 tesseract OCR 依赖
 *
 * 目标架构默认是当前进程的 platform-arch（与 node-pty 的 prebuilds 目录名一致，例如 win32-x64）。
 * afterPack 会传入本次 electron-builder 的目标，避免在 macOS / Linux 上误删该平台的预编译。
 *
 * 用法：
 *   node desktop/scripts/prune-bundle.cjs
 *   node desktop/scripts/prune-bundle.cjs --app-out <win-unpacked>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');

/**
 * officeparser 的可选 OCR 依赖。桌面端不传 ocr:true，
 * 图片交给模型 vision，屏幕文字走 Windows OCR，这些包不进安装包。
 */
const SKIP_OCR_PACKAGES = [
  'tesseract.js',
  'tesseract.js-core',
  'bmp-js',
  'idb-keyval',
  'is-url',
  'node-fetch',
  'opencollective-postinstall',
  'regenerator-runtime',
  'wasm-feature-detect',
  'zlibjs',
];

const DEBUG_EXTS = new Set(['.pdb', '.obj', '.iobj', '.ipdb', '.tlog']);
const MAP_EXTS = new Set(['.map']);
const KEEP_DOC_BASENAME = /^(license|licence|copying|notice|readme)/i;
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);
const PROTECTED_DIRS = ['data/'];

function log(msg) {
  process.stdout.write(`[prune-bundle] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[prune-bundle] ${msg}\n`);
}

function measure(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else {
        try {
          bytes += fs.statSync(p).size;
          files += 1;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { bytes, files };
}

const MB = (n) => (n / 1048576).toFixed(1);

function isTsSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

function isProtected(relPath) {
  return PROTECTED_DIRS.some((d) => relPath.startsWith(d));
}

function keepArchSet(keep) {
  const list = keep == null
    ? [`${process.platform}-${process.arch}`]
    : (Array.isArray(keep) ? keep : [keep]);
  return new Set(list.filter(Boolean));
}

/** prebuilds/<platform-arch>/ 不属于本次目标时整目录删除。 */
function shouldDropPrebuildDir(relPath, keepSet) {
  const marker = 'node-pty/prebuilds/';
  const idx = relPath.indexOf(marker);
  if (idx < 0) return false;
  const arch = relPath.slice(idx + marker.length).split('/')[0];
  return !!arch && !keepSet.has(arch);
}

function pruneTree(root, opts = {}) {
  const keepSet = keepArchSet(opts.keepPrebuildArch);
  let deletedFiles = 0;
  let deletedBytes = 0;

  const removeFile = (filePath, size) => {
    try {
      fs.rmSync(filePath, { force: true });
      deletedFiles += 1;
      deletedBytes += size;
    } catch {
      /* 占用或权限问题时跳过，打包结果里仍可能留下该文件 */
    }
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (isProtected(rel)) continue;

      if (entry.isDirectory()) {
        if (shouldDropPrebuildDir(`${rel}/`, keepSet)) {
          const s = measure(p);
          try {
            fs.rmSync(p, { recursive: true, force: true });
            deletedFiles += s.files;
            deletedBytes += s.bytes;
          } catch {
            /* ignore */
          }
          continue;
        }
        walk(p);
        continue;
      }

      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue;
      }

      const lower = entry.name.toLowerCase();
      const ext = path.extname(lower);
      if (DEBUG_EXTS.has(ext) || MAP_EXTS.has(ext)) {
        removeFile(p, size);
        continue;
      }
      if (isTsSource(lower)) {
        removeFile(p, size);
        continue;
      }
      if (ext === '.md' && !KEEP_DOC_BASENAME.test(entry.name)) {
        removeFile(p, size);
      }
    }
  };

  walk(root);
  return { deletedFiles, deletedBytes };
}

function requiredPrebuilds(arch) {
  if (arch.startsWith('win32-')) {
    return [
      `node_modules/node-pty/prebuilds/${arch}/conpty.node`,
      `node_modules/node-pty/prebuilds/${arch}/pty.node`,
    ];
  }
  return [`node_modules/node-pty/prebuilds/${arch}/pty.node`];
}

function releaseBinaries(arch) {
  if (arch.startsWith('win32-')) {
    return [
      'node_modules/node-pty/build/Release/conpty.node',
      'node_modules/node-pty/build/Release/pty.node',
    ];
  }
  return ['node_modules/node-pty/build/Release/pty.node'];
}

function existsRel(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

/**
 * node-pty 优先加载 build/Release，否则加载 prebuilds/<本次架构>。
 * 只保留一个架构时，两处有一处完整即可；同时保留多架构时，每个架构都要有自己的 prebuilds。
 */
function verifyNativeModules(bundleRoot, keepSet) {
  const ptyRoot = path.join(bundleRoot, 'node_modules', 'node-pty');
  if (!fs.existsSync(ptyRoot)) {
    warn(`SKIP native check: ${bundleRoot} 不含 node-pty`);
    return true;
  }

  const archs = [...keepSet];
  const allowRelease = archs.length === 1;
  const missing = [];
  for (const arch of archs) {
    const prebuildOk = requiredPrebuilds(arch).every((rel) => existsRel(bundleRoot, rel));
    const releaseOk = allowRelease && releaseBinaries(arch).every((rel) => existsRel(bundleRoot, rel));
    if (!prebuildOk && !releaseOk) {
      missing.push(arch);
    }
  }
  if (missing.length > 0) {
    warn(`node-pty 原生模块缺失，架构：${missing.join(', ')}`);
    return false;
  }
  if (!existsRel(bundleRoot, 'data/system-prompt.md')) {
    warn('data/system-prompt.md 缺失（data/ 应整目录保留）');
    return false;
  }
  return true;
}

function dropOcrPackages(bundleRoot) {
  const nm = path.join(bundleRoot, 'node_modules');
  let deletedFiles = 0;
  let deletedBytes = 0;
  if (!fs.existsSync(nm)) return { deletedFiles, deletedBytes };
  for (const name of SKIP_OCR_PACKAGES) {
    const dir = path.join(nm, name);
    if (!fs.existsSync(dir)) continue;
    const s = measure(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    deletedFiles += s.files;
    deletedBytes += s.bytes;
  }
  if (deletedFiles > 0) {
    log(`ocr: 删除 ${deletedFiles} 个文件，-${MB(deletedBytes)} MB（tesseract 及其专属依赖）`);
  }
  return { deletedFiles, deletedBytes };
}

function pruneServerBundle(bundleRoot, opts = {}) {
  if (!fs.existsSync(bundleRoot)) {
    log(`SKIP: ${bundleRoot} 不存在`);
    return null;
  }
  const keepSet = keepArchSet(opts.keepPrebuildArch);
  const before = measure(bundleRoot);
  const ocr = dropOcrPackages(bundleRoot);
  const result = pruneTree(bundleRoot, { keepPrebuildArch: [...keepSet] });
  result.deletedFiles += ocr.deletedFiles;
  result.deletedBytes += ocr.deletedBytes;
  const after = measure(bundleRoot);
  if (!verifyNativeModules(bundleRoot, keepSet)) {
    throw new Error(`瘦身后运行时文件缺失：${bundleRoot}`);
  }
  log(
    `server ${MB(before.bytes)} MB / ${before.files} files` +
      ` -> ${MB(after.bytes)} MB / ${after.files} files` +
      ` (删除 ${result.deletedFiles} 个文件，-${MB(result.deletedBytes)} MB，保留 ${[...keepSet].join(', ')})`,
  );
  return { before, after, ...result };
}

function pruneLocales(appOutDir) {
  const localesDir = path.join(appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return { removed: 0, removedBytes: 0 };
  let removed = 0;
  let removedBytes = 0;
  for (const name of fs.readdirSync(localesDir)) {
    if (KEEP_LOCALES.has(name)) continue;
    const p = path.join(localesDir, name);
    try {
      const s = fs.statSync(p);
      if (!s.isFile()) continue;
      fs.rmSync(p, { force: true });
      removed += 1;
      removedBytes += s.size;
    } catch {
      /* ignore */
    }
  }
  log(`locales: 删除 ${removed} 个语言包，-${MB(removedBytes)} MB（保留 zh-CN / en-US）`);
  return { removed, removedBytes };
}

function serverDirs(appOutDir) {
  return [
    path.join(appOutDir, 'resources', 'server'),
    path.join(appOutDir, 'Contents', 'Resources', 'server'),
  ];
}

/** afterPack：裁 locales，并再裁一次已打进包里的 server，避免漏跑打包前的 prune。 */
function pruneAppOut(appOutDir, opts = {}) {
  if (!appOutDir || !fs.existsSync(appOutDir)) return null;
  const locales = pruneLocales(appOutDir);
  const servers = [];
  for (const dir of serverDirs(appOutDir)) {
    if (!fs.existsSync(dir)) continue;
    servers.push(pruneServerBundle(dir, opts));
  }
  return { locales, servers };
}

function main() {
  const appOutIdx = process.argv.indexOf('--app-out');
  const bundleRoot = path.join(desktopRoot, 'server-bundle');
  pruneServerBundle(bundleRoot);
  if (appOutIdx >= 0 && process.argv[appOutIdx + 1]) {
    pruneAppOut(path.resolve(process.argv[appOutIdx + 1]));
  }
  log('done.');
}

module.exports = {
  pruneServerBundle,
  pruneAppOut,
  pruneTree,
  pruneLocales,
  measure,
  keepArchSet,
  SKIP_OCR_PACKAGES,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[prune-bundle] FAILED: ${(err && err.stack) || err}\n`);
    process.exit(1);
  }
}
