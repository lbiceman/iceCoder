#!/usr/bin/env node
/**
 * 品牌标只维护一份源图：src/public/icons/logo.png
 *
 * 打包 / 开发入口会先跑本脚本，按尺寸生成其余图标（圆角 + 系统图标内缩）。
 *
 *   npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const assetsDir = path.join(__dirname, '..', 'assets');
const publicDir = path.join(repoRoot, 'src', 'public');
const logoPngPath = path.join(publicDir, 'icons', 'logo.png');

/** 与 .ice-brand-logo { width: 28px; border-radius: 6px } 同比例 */
const CORNER_RADIUS_RATIO = 6 / 28;
/** 仅系统 / 浏览器 tab 图标内缩；侧栏 CSS 自己控制 */
const MARK_INSET_PX = 2;

function cornerRadius(size) {
  return Math.max(2, Math.round(size * CORNER_RADIUS_RATIO));
}

function roundedMaskSvg(size, radius) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>` +
      '</svg>',
  );
}

async function renderPng(size) {
  const radius = cornerRadius(size);
  const inner = Math.max(1, size - MARK_INSET_PX);
  const innerPng = await sharp(logoPngPath)
    .resize(inner, inner, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 255 },
    })
    .png()
    .toBuffer();

  const square = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 255 },
    },
  })
    .composite([{ input: innerPng, gravity: 'centre' }])
    .ensureAlpha()
    .png()
    .toBuffer();

  return sharp(square)
    .composite([{ input: roundedMaskSvg(size, radius), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function writeSvg(filePath, pngBuffer, label) {
  const fav128 = await sharp(pngBuffer).resize(128, 128).png().toBuffer();
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${label}">`,
    `  <title>${label}</title>`,
    `  <image href="data:image/png;base64,${fav128.toString('base64')}" width="128" height="128"/>`,
    '</svg>',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, svg);
}

async function main() {
  if (!fs.existsSync(logoPngPath)) {
    throw new Error(`missing ${logoPngPath}`);
  }

  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(path.join(publicDir, 'icons'), { recursive: true });

  const outputs = [
    path.join(assetsDir, 'icon.png'),
    path.join(assetsDir, 'icon.ico'),
    path.join(publicDir, 'favicon.ico'),
    path.join(publicDir, 'icons', 'favicon.svg'),
  ];
  const srcMtime = fs.statSync(logoPngPath).mtimeMs;
  const skip =
    process.env.FORCE_ICONS !== '1' &&
    outputs.every((p) => fs.existsSync(p) && fs.statSync(p).mtimeMs >= srcMtime);
  if (skip) {
    console.log('[generate-icons] up to date (src/public/icons/logo.png)');
    return;
  }

  const icon512 = await renderPng(512);
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), icon512);

  const ico = await pngToIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map((s) => renderPng(s))));
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);

  const favIco = await pngToIco(await Promise.all([16, 32, 48].map((s) => renderPng(s))));
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), favIco);

  await writeSvg(path.join(publicDir, 'icons', 'favicon.svg'), icon512, 'IceCoder');

  for (const leftover of [
    path.join(assetsDir, 'tray-icon.png'),
    path.join(assetsDir, 'notification-app-logo.png'),
    path.join(publicDir, 'icons', 'favicon.ico'),
    path.join(publicDir, 'icons', 'logo-dark.png'),
    path.join(publicDir, 'icons', 'logo.svg'),
  ]) {
    if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
  }

  console.log('[generate-icons] source  src/public/icons/logo.png');
  console.log('[generate-icons] wrote   desktop/assets/icon.png, icon.ico');
  console.log('[generate-icons] wrote   src/public/favicon.ico, icons/favicon.svg');
}

await main();
