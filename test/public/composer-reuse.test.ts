import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildComposerReusePayload,
  composerReuseHasContent,
  normalizeReuseImageUrl,
} from '../../src/public/js/composer-reuse.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('放回输入框', () => {
  it('还原正文、技能、文件引用、图片和上传文件，并补回模式命令', () => {
    const payload = buildComposerReusePayload({
      shellCommand: '/shell',
      content: [
        '看一下这个报错',
        '[file:11111111-2222-4333-8444-555555555555] notes.txt',
        '[file] notes.txt',
      ].join('\n'),
      skills: ['#调试.md', '调试.md'],
      referencePaths: ['D:\\work\\a.ts', 'D:/work/a.ts', 'D:\\work\\b.ts'],
      images: [
        'http://127.0.0.1:1024/api/sessions/abc/images/shot.png',
        '/api/sessions/abc/images/shot.png',
        'data:image/png;base64,aaaa',
      ],
      attachedFiles: [{
        fileId: '11111111-2222-4333-8444-555555555555',
        filename: 'notes.txt',
        size: 12,
      }],
    });

    expect(payload.text).toBe('/shell\n看一下这个报错');
    expect(payload.skills).toEqual(['调试.md']);
    expect(payload.fileRefs).toEqual(['D:\\work\\a.ts', 'D:\\work\\b.ts']);
    expect(payload.images).toEqual([
      '/api/sessions/abc/images/shot.png',
      'data:image/png;base64,aaaa',
    ]);
    expect(payload.uploadedFiles).toEqual([{
      fileId: '11111111-2222-4333-8444-555555555555',
      filename: 'notes.txt',
      size: 12,
    }]);
    expect(composerReuseHasContent(payload)).toBe(true);
  });

  it('纯图片占位和 /also 备注不会把占位文案塞回输入框', () => {
    expect(buildComposerReusePayload({
      content: '(图片)',
      images: ['/api/sessions/s/images/a.png'],
    })).toMatchObject({
      text: '',
      images: ['/api/sessions/s/images/a.png'],
    });

    expect(buildComposerReusePayload({
      alsoNote: true,
      content: '补一句',
    }).text).toBe('/also\n补一句');
  });

  it('没有文件 id 时保留文件名文本', () => {
    const payload = buildComposerReusePayload({
      content: '原文\n[file] lost.pdf',
    });
    expect(payload.text).toBe('原文\n[file] lost.pdf');
    expect(payload.uploadedFiles).toEqual([]);
  });

  it('空消息没有可放回的内容', () => {
    expect(composerReuseHasContent(buildComposerReusePayload({ content: '  ' }))).toBe(false);
    expect(composerReuseHasContent(buildComposerReusePayload(null))).toBe(false);
  });

  it('会话图片地址收成接口路径', () => {
    expect(normalizeReuseImageUrl('https://host/api/sessions/s1/images/a.webp?x=1'))
      .toBe('/api/sessions/s1/images/a.webp?x=1');
  });

  it('按钮、图标和发送时的文件记录都接上了', () => {
    const root = path.join(__dirname, '../../src/public');
    const ui = readFileSync(path.join(root, 'js/chat-ui.ts'), 'utf-8');
    const page = readFileSync(path.join(root, 'js/chat-page.ts'), 'utf-8');
    const main = readFileSync(path.join(root, 'js/main.ts'), 'utf-8');
    const svg = readFileSync(path.join(root, 'icons/reinput.svg'), 'utf-8');
    expect(ui).toContain("html('reinput'");
    expect(ui).toContain('放回输入框');
    expect(page).toContain('onReuse: handleMessageReuseAction');
    expect(page).toContain('userMsg.attachedFiles = attached');
    expect(main).toContain("import './composer-reuse.ts';");
    expect(svg).toContain('viewBox="0 0 16 16"');
  });
});
