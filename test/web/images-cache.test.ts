import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildImagePathHint,
  buildUserMessageWithImages,
  parseDataUrl,
  persistInlineImages,
} from '../../src/web/images-cache.js';
import { getImagesCacheSessionDir } from '../../src/cli/paths.js';

describe('images-cache', () => {
  it('parseDataUrl 解析 PNG base64', () => {
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const dataUrl = `data:image/png;base64,${png1x1}`;
    const parsed = parseDataUrl(dataUrl);
    expect(parsed?.mimeType).toBe('image/png');
    expect(parsed?.buffer.length).toBeGreaterThan(0);
  });

  it('persistInlineImages 写入 data/imagesCache/{sessionId}', async () => {
    const sessionId = 'test-session';
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const dataUrl = `data:image/png;base64,${png1x1}`;

    const saved = await persistInlineImages([dataUrl], sessionId);
    expect(saved).toHaveLength(1);
    expect(saved[0].absolutePath).toBe(
      path.join(getImagesCacheSessionDir(sessionId), path.basename(saved[0].absolutePath)),
    );
    expect(saved[0].absolutePath).toContain(path.join('imagesCache', sessionId));

    const stat = await fs.stat(saved[0].absolutePath);
    expect(stat.size).toBeGreaterThan(0);

    await fs.rm(path.dirname(saved[0].absolutePath), { recursive: true, force: true });
  });

  it('buildImagePathHint 非 vision 包含 image_read 指引', () => {
    const hint = buildImagePathHint(['D:\\data\\imagesCache\\sess\\abc.png'], false);
    expect(hint).toContain('image_read');
    expect(hint).toContain('user_uploaded_image');
    expect(hint).toContain('abc.png');
  });

  it('buildImagePathHint vision 不暴露路径、不引导 image_read', () => {
    const hint = buildImagePathHint(['D:\\data\\imagesCache\\sess\\abc.png'], true);
    expect(hint).toContain('无需调用 image_read');
    expect(hint).not.toContain('abc.png');
  });

  it('非 vision 时只返回纯文本且含路径', () => {
    const { content, harnessUserMessage } = buildUserMessageWithImages({
      userText: '这是什么',
      filePaths: [],
      imageAbsolutePaths: ['D:\\data\\imagesCache\\sess\\abc.png'],
      imageDataUrls: ['data:image/png;base64,abc'],
      supportsVision: false,
    });
    expect(typeof content).toBe('string');
    expect(harnessUserMessage).toContain('abc.png');
    expect(harnessUserMessage).toContain('image_read');
  });

  it('vision 时返回 ContentBlock 数组', () => {
    const dataUrl = 'data:image/png;base64,abc';
    const { content } = buildUserMessageWithImages({
      userText: '看图',
      filePaths: [],
      imageAbsolutePaths: ['D:\\data\\imagesCache\\sess\\abc.png'],
      imageDataUrls: [dataUrl],
      supportsVision: true,
    });
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'text', text: expect.stringContaining('无需调用 image_read') },
      { type: 'image', imageUrl: dataUrl },
    ]);
  });
});
