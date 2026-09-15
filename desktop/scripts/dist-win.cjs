/**
 * Windows 安装包：先从 logo.png 生成图标，禁用 electron-builder 可执行文件缓存。
 * 应用 exe 图标由 afterPack（stamp-win-icon.cjs）在 NSIS 封装前写入；
 * 不要在安装包生成后再 rcedit，否则会截断 NSIS 载荷。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const env = {
  ...process.env,
  ELECTRON_BUILDER_DISABLE_BUILD_CACHE: 'true',
};

const gen = spawnSync(process.execPath, [path.join(__dirname, 'generate-icons.mjs')], {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit',
});
if ((gen.status ?? 1) !== 0) process.exit(gen.status ?? 1);

const pack = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', '--win', 'nsis'],
  { cwd: path.join(__dirname, '..'), env, stdio: 'inherit', shell: true },
);
if ((pack.status ?? 1) !== 0) process.exit(pack.status ?? 1);

const installer = path.join(__dirname, '..', 'release', 'iceCoder-windows.exe');
if (!fs.existsSync(installer)) {
  process.stderr.write('[dist-win] 未找到安装包: ' + installer + '\n');
  process.exit(1);
}
const MIN_INSTALLER_BYTES = 10 * 1024 * 1024;
const installerSize = fs.statSync(installer).size;
if (installerSize < MIN_INSTALLER_BYTES) {
  process.stderr.write(
    `[dist-win] 安装包疑似被截断：${installer} 仅 ${installerSize} 字节` +
      `（NSIS 载荷被 rcedit 裁掉后通常只剩几百 KB）。不要对安装包运行 rcedit。\n`,
  );
  process.exit(1);
}
process.exit(0);
