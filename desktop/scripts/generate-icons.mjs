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
const publicDir = path.join(__dirname, '..', '..', 'src', 'public');
const logoPngPath = path.join(publicDir, 'icons', 'logo.png');

async function renderPng(size) {
  return sharp(logoPngPath)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 255 },
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

  const favIco = await pngToIco(await Promise.all([16, 32, 48].map((s) => renderPng(s))));
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), favIco);
  fs.writeFileSync(path.join(publicDir, 'icons', 'favicon.ico'), favIco);

  const fav128 = await renderPng(128);
  const favSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="IceCoder">',
    '  <title>IceCoder</title>',
    `  <image href="data:image/png;base64,${fav128.toString('base64')}" width="128" height="128"/>`,
    '</svg>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(publicDir, 'icons', 'favicon.svg'), favSvg);

  console.log('[generate-icons] wrote icon.png (512), tray-icon.png (32), notification-app-logo.png (44), icon.ico, public favicon.ico / favicon.svg');
  console.log('[generate-icons] macOS .icns 将在 electron-builder --mac 时由 icon.png 自动转换');
}

main().catch((err) => {
  process.stderr.write(`[generate-icons] FAILED: ${err && err.stack || err}\n`);
  process.exit(1);
});
