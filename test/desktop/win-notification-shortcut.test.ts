import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveNotificationShortcutIconPath,
  resolveWindowsNotificationShortcutPath,
} from '../../desktop/src/win-notification-shortcut.js';

describe('resolveNotificationShortcutIconPath', () => {
  it('优先 icon.ico（首页品牌标同源）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-notify-icon-'));
    const ico = path.join(dir, 'icon.ico');
    fs.writeFileSync(ico, 'x');
    fs.writeFileSync(path.join(dir, 'icon.png'), 'y');
    expect(resolveNotificationShortcutIconPath(dir)).toBe(ico);
  });
});

describe('resolveWindowsNotificationShortcutPath', () => {
  it('写入开始菜单 Programs 目录', () => {
    const p = resolveWindowsNotificationShortcutPath('C:\\Users\\me\\AppData\\Roaming');
    expect(p).toContain('Start Menu');
    expect(p.endsWith('iceCoder.lnk')).toBe(true);
  });
});
