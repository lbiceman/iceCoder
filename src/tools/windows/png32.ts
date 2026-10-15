/**
 * 把 GDI 的自下而上 BGRA 写成 PNG。
 * 视觉接口通常只收 PNG / JPEG，不收 BMP。压缩用 Node 自带的 zlib。
 */

import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  return out;
}

export function encodePngFromBottomUpBgra(width: number, height: number, pixels: Buffer): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG size ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new Error(`PNG pixel buffer is ${pixels.length} bytes, expected ${expected}`);
  }

  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride;
    const dst = y * (1 + stride);
    raw[dst] = 0;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + 1 + x * 4;
      raw[d] = pixels[s + 2];
      raw[d + 1] = pixels[s + 1];
      raw[d + 2] = pixels[s];
      raw[d + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
