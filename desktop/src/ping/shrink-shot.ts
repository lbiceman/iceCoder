/**
 * 待办截图送去保存前缩小，避免撑过 Express 的 JSON 上限。
 */
import { nativeImage } from 'electron';

const MAX_EDGE = 1600;
const MAX_CHARS = 1_200_000;

export function shrinkPngDataUrl(dataUrl: string): string {
  let image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return dataUrl;
  let size = image.getSize();
  const edge = Math.max(size.width, size.height);
  if (edge > MAX_EDGE) {
    const scale = MAX_EDGE / edge;
    image = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    });
  }
  let url = image.toDataURL();
  for (let i = 0; i < 6 && url.length > MAX_CHARS; i++) {
    size = image.getSize();
    const width = Math.max(1, Math.round(size.width * 0.75));
    const height = Math.max(1, Math.round(size.height * 0.75));
    if (width === size.width && height === size.height) break;
    image = image.resize({ width, height, quality: 'good' });
    url = image.toDataURL();
  }
  return url;
}
