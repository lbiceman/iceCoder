#!/usr/bin/env node
/**
 * 从 src/public/icons/logo.png（首页品牌标）生成 Electron 用 PNG / ICO / 托盘 / 通知图标。
 * 与侧栏、欢迎页同一张图，不从 SVG 重绘，避免轮廓跑样。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'assets');
const logoPngPath = path.join(__dirname, '..', '..', 'src', 'public', 'icons', 'logo.png');

async function renderPng(size) {
  return sharp(logoPngPath)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function main() {
  if (!fs.existsSync(logoPngPath)) {
    throw new Error(`missing ${logoPngPath}`);
  }

  const icon512 = await renderPng(512);
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), icon512);

  const tray32 = await renderPng(32);
  fs.writeFileSync(path.join(assetsDir, 'tray-icon.png'), tray32);

  const notify44 = await renderPng(44);
  fs.writeFileSync(path.join(assetsDir, 'notification-app-logo.png'), notify44);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(icoSizes.map((s) => renderPng(s)));
  const ico = await pngToIco(icoBuffers);
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);

  console.log('[generate-icons] wrote icon.png (512), tray-icon.png (32), notification-app-logo.png (44), icon.ico');
  console.log('[generate-icons] macOS .icns 将在 electron-builder --mac 时由 icon.png 自动转换');
}

main().catch((err) => {
  process.stderr.write(`[generate-icons] FAILED: ${err && err.stack || err}\n`);
  process.exit(1);
});
