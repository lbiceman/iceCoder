/**
 * after-pack.cjs — electron-builder afterPack 编排
 *
 * electron-builder 的 afterPack 只支持单个钩子，这里按顺序组合：
 *   1. stamp-win-icon.cjs：把 assets/icon.ico 写入 win-unpacked/iceCoder.exe（须在 NSIS 封装前）
 *   2. prune-bundle.cjs：A+B 裁 server，C 档 locales 只保留 zh-CN / en-US
 *
 * 注意：不能对 NSIS 安装包本身运行 rcedit，详见 stamp-win-icon.cjs 注释。
 */
'use strict';

const stampWinIcon = require('./stamp-win-icon.cjs');
const { pruneAppOut } = require('./prune-bundle.cjs');

/** 与 electron-builder Arch 枚举一致。 */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

function archName(arch) {
  if (typeof arch === 'string' && arch) return arch;
  if (typeof arch === 'number') return ARCH_NAMES[arch] || '';
  return '';
}

function keepPrebuildArch(context) {
  const platform = context && context.electronPlatformName;
  const arch = archName(context && context.arch);
  if (!platform || !arch) return undefined;
  if (arch === 'universal') return [`${platform}-x64`, `${platform}-arm64`];
  return `${platform}-${arch}`;
}

async function afterPack(context) {
  await stampWinIcon(context);
  pruneAppOut(context.appOutDir, { keepPrebuildArch: keepPrebuildArch(context) });
}

module.exports = afterPack;
