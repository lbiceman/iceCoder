/**
 * electron-builder afterPack：把 assets/icon.ico 写入 win-unpacked/iceCoder.exe，
 * 再交给 NSIS 封装。禁止 rcedit 安装包本身——NSIS 把载荷追加在 PE 尾部，
 * UpdateResource 会截断尾部并触发 “Installer integrity check has failed”。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const desktopRoot = path.join(__dirname, '..');
const ico = path.join(desktopRoot, 'assets', 'icon.ico');

function findRcedit() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
  const names = ['rcedit-x64.exe', 'rcedit.exe'];
  const found = [];
  if (fs.existsSync(cacheRoot)) {
    for (const dirent of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      for (const name of names) {
        const candidate = path.join(cacheRoot, dirent.name, name);
        if (fs.existsSync(candidate)) found.push(candidate);
      }
    }
  }
  if (found.length === 0) {
    throw new Error('找不到 rcedit，无法写入 Windows 图标');
  }
  found.sort();
  return found[found.length - 1];
}

function assertNotNsisInstaller(exe) {
  const base = path.basename(exe).toLowerCase();
  if (base.endsWith('-windows.exe') || base.includes('setup')) {
    throw new Error('不能对 NSIS 安装包运行 rcedit（会截断 CRC 载荷）: ' + exe);
  }
}

function stamp(exe, rcedit, version) {
  if (!fs.existsSync(exe)) {
    process.stderr.write('[stamp-win-icon] skip missing ' + exe + '\n');
    return;
  }
  assertNotNsisInstaller(exe);
  const result = spawnSync(
    rcedit,
    [exe, '--set-icon', ico, '--set-file-version', version, '--set-product-version', version],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error('rcedit 失败: ' + exe + (detail ? '\n' + detail : ''));
  }
  process.stdout.write('[stamp-win-icon] ' + exe + '\n');
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (!fs.existsSync(ico)) {
    throw new Error('missing ' + ico);
  }
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exe = path.join(context.appOutDir, exeName);
  const version = String(context.packager.appInfo.version || '1.0.0');
  stamp(exe, findRcedit(), version);
}

function main() {
  if (!fs.existsSync(ico)) {
    throw new Error('missing ' + ico);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const version = String(pkg.version || '1.0.0');
  stamp(path.join(desktopRoot, 'release', 'win-unpacked', 'iceCoder.exe'), findRcedit(), version);
}

module.exports = afterPack;

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write('[stamp-win-icon] FAILED: ' + (err && err.stack || err) + '\n');
    process.exit(1);
  }
}
