/**
 * 从参考图（PNG / JPEG）抽取 outSize×outSize 二值网格，输出 session-pet.js 用 DOG_ASCII 行。
 * 用法: node scripts/extract-session-pet-grid.mjs <输入> [outSize=64]
 */
import fs from 'fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const src = process.argv[2];
const outSize = parseInt(process.argv[3] || '64', 10) || 64;

if (!src || !fs.existsSync(src)) {
  console.error('用法: node scripts/extract-session-pet-grid.mjs <输入.png|jpg> [64]');
  process.exit(1);
}

const raw = fs.readFileSync(src);
let width;
let height;
let data;
let channels;

if (raw[0] === 0x89 && raw[1] === 0x50) {
  const png = PNG.sync.read(raw);
  width = png.width;
  height = png.height;
  data = png.data;
  channels = 4;
} else {
  const decoded = jpeg.decode(raw, { useTArray: true });
  width = decoded.width;
  height = decoded.height;
  data = decoded.data;
  const px = width * height;
  channels = decoded.data.length >= px * 4 ? 4 : 3;
}

function lumAt(x, y) {
  const i = (width * y + x) * channels;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const a = channels === 4 ? data[i + 3] : 255;
  if (a < 16) return 255;
  return (r + g + b) / 3;
}

let minX = width;
let minY = height;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (lumAt(x, y) < 200) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}
if (minX > maxX) {
  minX = 0;
  minY = 0;
  maxX = width - 1;
  maxY = height - 1;
}

const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
const bw = maxX - minX + 1;
const bh = maxY - minY + 1;
const side = Math.max(bw, bh) * 1.04;
let x0 = Math.floor(cx - side / 2);
let y0 = Math.floor(cy - side / 2);
if (x0 < 0) x0 = 0;
if (y0 < 0) y0 = 0;
let x1 = Math.ceil(x0 + side);
let y1 = Math.ceil(y0 + side);
if (x1 > width) {
  x1 = width;
  x0 = Math.max(0, width - (x1 - x0));
}
if (y1 > height) {
  y1 = height;
  y0 = Math.max(0, height - (y1 - y0));
}

const cropW = x1 - x0;
const cropH = y1 - y0;

function sampleBlock(tx, ty) {
  const xStart = x0 + Math.floor((tx * cropW) / outSize);
  const yStart = y0 + Math.floor((ty * cropH) / outSize);
  const xEnd = Math.min(x1, x0 + Math.ceil(((tx + 1) * cropW) / outSize));
  const yEnd = Math.min(y1, y0 + Math.ceil(((ty + 1) * cropH) / outSize));
  let sum = 0;
  let n = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      sum += lumAt(x, y);
      n++;
    }
  }
  return sum / n < 155 ? '#' : '.';
}

const lines = [];
for (let ty = 0; ty < outSize; ty++) {
  let row = '';
  for (let tx = 0; tx < outSize; tx++) {
    row += sampleBlock(tx, ty);
  }
  lines.push(row);
}

process.stderr.write(`// ${width}x${height} -> ${outSize}x${outSize} crop ${cropW}x${cropH}\n`);
const body = lines.map((l) => `    '${l}',`).join('\n') + '\n';
const outPath = process.argv[4];
if (outPath) {
  fs.writeFileSync(outPath, body, 'utf8');
} else {
  process.stdout.write(body);
}
