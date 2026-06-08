#!/usr/bin/env node
/**
 * 从 assets/icon.svg 生成 Electron 用 PNG / ICO / 托盘图标。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'assets');
/** 与 Web favicon 共用同一矢量源 */
const svgPath = path.join(__dirname, '..', '..', 'src', 'public', 'favicon.svg');

async function renderPng(size) {
  const svg = fs.readFileSync(svgPath);
  return sharp(svg, { density: Math.max(72, Math.round((size / 96) * 144)) })
    .resize(size, size)
    .png()
    .toBuffer();
}

async function main() {
  if (!fs.existsSync(svgPath)) {
    throw new Error(`missing ${svgPath}`);
  }

  const icon512 = await renderPng(512);
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), icon512);

  const tray32 = await renderPng(32);
  fs.writeFileSync(path.join(assetsDir, 'tray-icon.png'), tray32);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(icoSizes.map((s) => renderPng(s)));
  const ico = await pngToIco(icoBuffers);
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);

  console.log('[generate-icons] wrote icon.png (512), tray-icon.png (32), icon.ico');
  console.log('[generate-icons] macOS .icns 将在 electron-builder --mac 时由 icon.png 自动转换');
}

main().catch((err) => {
  process.stderr.write(`[generate-icons] FAILED: ${err && err.stack || err}\n`);
  process.exit(1);
});
