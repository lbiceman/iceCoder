/**
 * 将 desktop/release/iceCoder-windows.exe 复制到 releases/windows/ 供 README 下载链接使用。
 */
const fs = require('fs');
const path = require('path');

const ARTIFACT = 'iceCoder-windows.exe';
const src = path.join(__dirname, '..', 'release', ARTIFACT);
const dest = path.join(__dirname, '..', '..', 'releases', 'windows', ARTIFACT);

if (!fs.existsSync(src)) {
  process.stderr.write('[copy-release-win] 未找到构建产物: ' + src + '\n');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
process.stdout.write('[copy-release-win] ' + dest + '\n');
