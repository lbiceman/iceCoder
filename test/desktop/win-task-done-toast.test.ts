import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWindowsTaskDoneToastXml,
  escapeXml,
  resolveWindowsToastAppLogoPath,
  toWindowsFileUri,
} from '../../desktop/src/win-task-done-toast.js';

describe('buildWindowsTaskDoneToastXml', () => {
  it('转义 XML 特殊字符', () => {
    expect(escapeXml('a & b <c>')).toBe('a &amp; b &lt;c&gt;');
  });

  it('包含圆形 appLogoOverride 与 hero', () => {
    const xml = buildWindowsTaskDoneToastXml({
      title: 'iceCoder 任务完成',
      body: '用户任务【写脚本】已完成。请确认。',
      appLogoPath: 'C:\\iceCoder\\assets\\notification-app-logo.png',
      heroIconPath: 'C:\\iceCoder\\assets\\icon.png',
    });
    expect(xml).toContain('template="ToastGeneric"');
    expect(xml).toContain('placement="appLogoOverride"');
    expect(xml).toContain('hint-crop="circle"');
    expect(xml).toContain('placement="hero"');
    expect(xml).toContain('iceCoder 任务完成');
    expect(xml).toContain('file:///');
  });

  it('无 logo / hero 时不注入 image 节点', () => {
    const xml = buildWindowsTaskDoneToastXml({
      title: 't',
      body: 'b',
      appLogoPath: null,
      heroIconPath: null,
    });
    expect(xml).not.toContain('appLogoOverride');
    expect(xml).not.toContain('placement="hero"');
  });
});

describe('resolveWindowsToastAppLogoPath', () => {
  it('优先 notification-app-logo.png', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-toast-logo-'));
    const preferred = path.join(dir, 'notification-app-logo.png');
    fs.writeFileSync(preferred, 'x');
    fs.writeFileSync(path.join(dir, 'icon.png'), 'y');
    expect(resolveWindowsToastAppLogoPath(dir)).toBe(preferred);
  });
});

describe('toWindowsFileUri', () => {
  it('生成 file:/// URI', () => {
    expect(toWindowsFileUri('C:\\a\\b.png')).toMatch(/^file:\/\/\//);
  });
});
