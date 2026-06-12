/**
 * 端口探测工具。
 * 优先使用 get-port 包；如未安装则回退到自实现顺序探测。
 */
import net from 'node:net';

export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, host);
  });
}

/** 从 start 开始（含）顺序探测空闲端口，最多 tryLimit 次。 */
export async function getAvailablePort(
  start: number,
  tryLimit = 50,
  host = '127.0.0.1',
): Promise<number> {
  for (let i = 0; i < tryLimit; i++) {
    const candidate = start + i;
    // skip(0)
    if (await isPortFree(candidate, host)) {
      return candidate;
    }
  }
  throw new Error(`No free port found in [${start}, ${start + tryLimit})`);
}
