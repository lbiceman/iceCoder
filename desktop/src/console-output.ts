import iconv from 'iconv-lite';

/**
 * Windows 集成终端（含 Cursor/VS Code）常仍为 CP936，直接写 UTF-8 中文会乱码。
 * 默认转 GBK；若终端已 UTF-8，可设 ICE_CONSOLE_UTF8=1 跳过转码。
 */
export function encodeConsoleText(text: string): string | Buffer {
  if (process.platform !== 'win32') return text;
  if (process.env.ICE_CONSOLE_UTF8 === '1') return text;
  return iconv.encode(text, 'gbk');
}

export function writeConsole(stream: NodeJS.WriteStream, text: string): void {
  stream.write(encodeConsoleText(text));
}
