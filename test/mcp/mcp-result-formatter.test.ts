import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

import { formatMcpToolResult } from '../../src/mcp/mcp-result-formatter.js';
import { getMcpCacheDir } from '../../src/cli/paths.js';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('formatMcpToolResult', () => {
  it('保留纯文本 MCP 输出', async () => {
    const formatted = await formatMcpToolResult({
      content: [{ type: 'text', text: 'Navigated to https://example.com' }],
    });
    expect(formatted.output).toBe('Navigated to https://example.com');
    expect(formatted.savedImagePaths).toEqual([]);
  });

  it('将 image 块落盘并附带 image_read 路径指引', async () => {
    const formatted = await formatMcpToolResult({
      content: [
        { type: 'text', text: "Screenshot 'current-page' taken at 1200x800" },
        { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
      ],
    });

    expect(formatted.output).toContain("Screenshot 'current-page' taken at 1200x800");
    expect(formatted.output).toContain('image_read');
    expect(formatted.savedImagePaths).toHaveLength(1);
    expect(formatted.savedImagePaths[0]).toBe(
      path.join(getMcpCacheDir(), path.basename(formatted.savedImagePaths[0])),
    );

    const stat = await fs.stat(formatted.savedImagePaths[0]);
    expect(stat.size).toBeGreaterThan(0);

    await fs.unlink(formatted.savedImagePaths[0]);
  });

  it('将 encoded data URL 文本落盘而非回传 base64', async () => {
    const formatted = await formatMcpToolResult({
      content: [
        { type: 'text', text: "Screenshot 'encoded' taken at 800x600" },
        { type: 'text', text: `data:image/png;base64,${PNG_1X1}` },
      ],
    });

    expect(formatted.output).not.toContain('base64,');
    expect(formatted.output).toContain('image_read');
    expect(formatted.savedImagePaths).toHaveLength(1);

    await fs.unlink(formatted.savedImagePaths[0]);
  });

  it('保留现代协议的结构化结果、资源和音频说明', async () => {
    const formatted = await formatMcpToolResult({
      resultType: 'complete',
      content: [
        { type: 'resource_link', name: '页面', uri: 'https://example.com/page' },
        {
          type: 'resource',
          resource: { uri: 'file:///result.txt', mimeType: 'text/plain', text: 'resource body' },
        },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      ],
      structuredContent: { browserId: 'browser-123', pageId: 'page-456' },
    });

    expect(formatted.output).toContain('[页面] https://example.com/page');
    expect(formatted.output).toContain('resource body');
    expect(formatted.output).toContain('[音频内容] audio/wav');
    expect(formatted.output).toContain('"browserId": "browser-123"');
  });

  it('未知扩展内容块不会被静默丢弃', async () => {
    const formatted = await formatMcpToolResult({
      content: [{ type: 'custom_block', value: 'future payload' }],
    });

    expect(formatted.output).toContain('[MCP 内容块: custom_block]');
    expect(formatted.output).toContain('future payload');
  });
});
