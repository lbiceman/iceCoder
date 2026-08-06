#!/usr/bin/env node
/**
 * rebuild-server-native.cjs
 * 将 server-bundle 中的原生模块（node-pty）重编译为 Electron 内置 Node 的 ABI。
 *
 * 桌面端以 ELECTRON_RUN_AS_NODE 启动 server-bundle，须与 desktop/node_modules/electron 版本一致。
 *
 * 用法: node desktop/scripts/rebuild-server-native.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const serverBundle = path.join(desktopRoot, 'server-bundle');
const electronPkgPath = path.join(desktopRoot, 'node_modules', 'electron', 'package.json');
const rebuildCli = path.join(desktopRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');

function log(msg) {
  process.stdout.write(`[rebuild-server-native] ${msg}\n`);
}

function main() {
  const nodePtyDir = path.join(serverBundle, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDir)) {
    log('SKIP: node-pty not in server-bundle (run copy-server-artifacts first)');
    return;
  }

  if (!fs.existsSync(electronPkgPath)) {
    throw new Error('desktop/node_modules/electron missing — run npm install in desktop/');
  }
  if (!fs.existsSync(rebuildCli)) {
    throw new Error('desktop/node_modules/@electron/rebuild missing — run npm install in desktop/');
  }

  const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8')).version;
  log(`electron=${electronVersion} module=node-pty target=${serverBundle}`);

  const result = spawnSync(
    process.execPath,
    [rebuildCli, `--version=${electronVersion}`, '-f', '-w', 'node-pty', '-m', serverBundle],
    { cwd: desktopRoot, stdio: 'inherit', env: process.env },
  );

  if (result.status !== 0) {
    throw new Error(
      `@electron/rebuild exited with code ${result.status ?? 'unknown'}. ` +
        'Desktop 打包需安装 Visual Studio「使用 C++ 的桌面开发」工作负载以编译 node-pty；' +
        '仅 CLI / 开发服务器可用 npm run smoke:node-pty 验证（系统 Node ABI）。',
    );
  }

  log('done.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[rebuild-server-native] FAILED: ${err && err.stack || err}\n`);
    process.exit(1);
  }
}

module.exports = { main };
