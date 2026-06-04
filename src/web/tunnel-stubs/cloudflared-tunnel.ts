/** 发布包 stub：不拉起 cloudflared 子进程。 */

import type { ChildProcess } from 'node:child_process';

export async function startTunnel(_port: number, _tunnelBin?: string): Promise<ChildProcess | null> {
  return null;
}
