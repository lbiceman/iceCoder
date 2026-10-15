import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePngFromBottomUpBgra } from '../../src/tools/windows/png32.js';
import { getWin32Desktop } from '../../src/tools/windows/win32-desktop.js';

const onWindows = process.platform === 'win32';

describe.skipIf(!onWindows)('win32 desktop input', () => {
  it('accepts a zero mouse move without leaving the pointer elsewhere', () => {
    const desktop = getWin32Desktop();
    const result = desktop.pointerNudgeZero();
    expect(result.sent).toBe(1);
    expect(result.moved).toBe(false);
  });

  it('captures the primary screen as a PNG whose size matches the monitor', async () => {
    const desktop = getWin32Desktop();
    const shot = desktop.capturePrimary();
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(shot.pixels.length).toBe(shot.width * shot.height * 4);
    const file = encodePngFromBottomUpBgra(shot.width, shot.height, shot.pixels);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-win-shot-'));
    const filePath = path.join(dir, 'screen.png');
    await fs.writeFile(filePath, file);
    const header = await fs.readFile(filePath);
    expect(header.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(header.readUInt32BE(16)).toBe(shot.width);
    expect(header.readUInt32BE(20)).toBe(shot.height);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
