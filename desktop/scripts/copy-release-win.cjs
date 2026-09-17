/**
 * 将 desktop/release/iceCoder-windows.exe 复制到 releases/windows/ 供 README 下载链接使用。
 * 目标文件若被资源管理器 / 安装包占用，会重试后再报错。
 */
const fs = require('fs');
const path = require('path');

const ARTIFACT = 'iceCoder-windows.exe';
const src = path.join(__dirname, '..', 'release', ARTIFACT);
const dest = path.join(__dirname, '..', '..', 'releases', 'windows', ARTIFACT);
const retries = 8;
const delayMs = 400;

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy wait：脚本很短，避免引入额外依赖 */
  }
}

function copyWithRetry() {
  let lastErr;
  for (let i = 1; i <= retries; i += 1) {
    try {
      const tmp = dest + '.tmp';
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      try { fs.unlinkSync(dest + '.tmp'); } catch (_) { /* ignore */ }
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!busy || i === retries) break;
      process.stderr.write(
        `[copy-release-win] ${dest} 被占用，${delayMs}ms 后重试 (${i}/${retries})\n`,
      );
      sleep(delayMs);
    }
  }
  throw lastErr;
}

if (!fs.existsSync(src)) {
  process.stderr.write('[copy-release-win] 未找到构建产物: ' + src + '\n');
  process.exit(1);
}

const MIN_INSTALLER_BYTES = 10 * 1024 * 1024;
const installerSize = fs.statSync(src).size;
if (installerSize < MIN_INSTALLER_BYTES) {
  process.stderr.write(
    `[copy-release-win] 安装包疑似被截断：${src} 仅 ${installerSize} 字节` +
      `（NSIS 载荷被 rcedit 裁掉后通常只剩几百 KB）。请重新打包。\n`,
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
try {
  copyWithRetry();
} catch (err) {
  process.stderr.write(
    '[copy-release-win] 无法覆盖 ' + dest +
      '：文件被占用。请关闭已打开的安装包 / iceCoder 后重试。\n' +
      (err && err.stack ? err.stack : String(err)) + '\n',
  );
  process.exit(1);
}
process.stdout.write('[copy-release-win] ' + dest + '\n');
