#!/usr/bin/env node
/**
 * 将用户提供的 ICE 立方体原图抠白底，写出 logo.png / logo-dark.png / favicon.svg / logo.svg。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const logo512 = await sharp(padded)
  .resize(512, 512, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

const logoDark = await sharp(logo512)
  .modulate({ brightness: 1.14, saturation: 1.22 })
  .png()
  .toBuffer();

fs.writeFileSync(path.join(outDir, 'logo.png'), logo512);
fs.writeFileSync(path.join(outDir, 'logo-dark.png'), logoDark);

async function writeSvg(fileName, pngBuffer, label) {
  const fav128 = await sharp(pngBuffer).resize(128, 128).png().toBuffer();
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${label}">`,
    `  <title>${label}</title>`,
    `  <image href="data:image/png;base64,${fav128.toString('base64')}" width="128" height="128"/>`,
    '</svg>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, fileName), svg);
}

await writeSvg('favicon.svg', logoDark, 'IceCoder');
await writeSvg('logo.svg', logo512, 'IceCoder');

console.log('[process-brand-logo] wrote logo.png, logo-dark.png, favicon.svg, logo.svg');
