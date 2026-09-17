#!/usr/bin/env node
/**
 * 把任意原图处理成唯一品牌源图 src/public/icons/logo.png，再生成其余尺寸。
 *
 *   node desktop/scripts/process-brand-logo.mjs <source-image>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const outDir = path.join(repoRoot, 'src', 'public', 'icons');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  throw new Error('usage: node desktop/scripts/process-brand-logo.mjs <source-image>');
}

const { data, info } = await sharp(src).removeAlpha().ensureAlpha().raw().toBuffer({
  resolveWithObject: true,
});
const w = info.width;
const h = info.height;
const out = Buffer.from(data);
for (let i = 0; i < w * h; i += 1) {
  const o = i * 4;
  const r = out[o];
  const g = out[o + 1];
  const b = out[o + 2];
  const dist = Math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2);
  if (dist < 20) out[o + 3] = 0;
  else if (dist < 48) out[o + 3] = Math.round((255 * (dist - 20)) / 28);
}

const knocked = await sharp(out, { raw: { width: w, height: h, channels: 4 } })
  .trim({ threshold: 8 })
  .png()
  .toBuffer();

const trimmedMeta = await sharp(knocked).metadata();
const pad = Math.round(Math.max(trimmedMeta.width, trimmedMeta.height) * 0.08);
const side = Math.max(trimmedMeta.width, trimmedMeta.height) + pad * 2;
const padded = await sharp({
  create: {
    width: side,
    height: side,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([{ input: knocked, gravity: 'centre' }])
  .png()
  .toBuffer();

const { data: padData, info: padInfo } = await sharp(padded)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const whiteMark = Buffer.from(padData);
for (let i = 0; i < padInfo.width * padInfo.height; i += 1) {
  const o = i * 4;
  if (whiteMark[o + 3] > 0) {
    whiteMark[o] = 255;
    whiteMark[o + 1] = 255;
    whiteMark[o + 2] = 255;
  }
}
const whiteOnClear = await sharp(whiteMark, {
  raw: { width: padInfo.width, height: padInfo.height, channels: 4 },
})
  .png()
  .toBuffer();

const logoMono = await sharp({
  create: {
    width: padInfo.width,
    height: padInfo.height,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 255 },
  },
})
  .composite([{ input: whiteOnClear }])
  .png()
  .toBuffer();

const logo512 = await sharp(logoMono)
  .resize(512, 512, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 255 },
  })
  .png()
  .toBuffer();

fs.writeFileSync(path.join(outDir, 'logo.png'), logo512);
console.log('[process-brand-logo] wrote src/public/icons/logo.png');

const gen = spawnSync(process.execPath, [path.join(__dirname, 'generate-icons.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if ((gen.status ?? 1) !== 0) process.exit(gen.status ?? 1);
