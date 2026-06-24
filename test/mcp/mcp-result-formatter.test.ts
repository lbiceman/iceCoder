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
});
