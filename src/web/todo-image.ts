/**
 * 待办正文和截图的校验。截图只收 PNG data URL，宽高从 IHDR 读，不信调用方报的尺寸。
 */

export const TODO_TEXT_MAX = 500;
export const TODO_PNG_MAX_BYTES = 4 * 1024 * 1024;

export const TODO_EMPTY_MESSAGE = '待办内容不能为空';
export const TODO_TEXT_LONG_MESSAGE = '待办最多 500 字';
export const TODO_IMAGE_INVALID_MESSAGE = '截图格式无效';
export const TODO_IMAGE_LARGE_MESSAGE = '截图太大';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodeTodoPng(raw: unknown): { png: Buffer; width: number; height: number } | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new Error(TODO_IMAGE_INVALID_MESSAGE);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(raw.trim());
  if (!match) throw new Error(TODO_IMAGE_INVALID_MESSAGE);
  const png = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  if (png.length > TODO_PNG_MAX_BYTES) throw new Error(TODO_IMAGE_LARGE_MESSAGE);
  const size = readPngSize(png);
  if (!size) throw new Error(TODO_IMAGE_INVALID_MESSAGE);
  return { png, ...size };
}

export function normalizeTodoText(raw: unknown, hasImage: boolean): string {
  if (raw == null) {
    if (!hasImage) throw new Error(TODO_EMPTY_MESSAGE);
    return '';
  }
  if (typeof raw !== 'string') throw new Error(TODO_EMPTY_MESSAGE);
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text.length > TODO_TEXT_MAX) throw new Error(TODO_TEXT_LONG_MESSAGE);
  if (!text && !hasImage) throw new Error(TODO_EMPTY_MESSAGE);
  return text;
}

function readPngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24) return null;
  if (!png.subarray(0, 8).equals(PNG_SIG)) return null;
  if (png.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 20_000 || height > 20_000) return null;
  return { width, height };
}
