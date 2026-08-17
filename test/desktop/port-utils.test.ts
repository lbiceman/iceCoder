import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { getAvailablePort, isPortFree } from '../../desktop/src/port-utils.js';

function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('port-utils', () => {
  it('isPortFree 对空闲端口返回 true', async () => {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    expect(await isPortFree(port)).toBe(true);
  });

  it('isPortFree 对被占用端口返回 false', async () => {
    const server = await occupyPort(0);
    const { port } = server.address() as net.AddressInfo;
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('getAvailablePort 跳过被占端口、返回首个空闲端口', async () => {
    const occupied = await occupyPort(0);
    const { port } = occupied.address() as net.AddressInfo;
    try {
      const found = await getAvailablePort(port, 3);
      expect(found).toBe(port + 1);
      expect(await isPortFree(found)).toBe(true);
    } finally {
      occupied.close();
    }
  });

  it('getAvailablePort 全部被占时抛错', async () => {
    const servers: net.Server[] = [];
    const start = 22_000 + Math.floor(Math.random() * 20_000);
    for (let i = 0; i < 3; i++) {
      const server = await occupyPort(start + i);
      servers.push(server);
    }
    try {
      await expect(getAvailablePort(start, 3)).rejects.toThrow(/No free port/);
    } finally {
      servers.forEach((s) => s.close());
    }
  });
});
