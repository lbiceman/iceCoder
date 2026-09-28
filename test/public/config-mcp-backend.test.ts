import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL = readFileSync(path.join(__dirname, '../../src/public/js/config-mcp-panel.ts'), 'utf-8');
const CSS = readFileSync(path.join(__dirname, '../../src/public/css/config.css'), 'utf-8');

describe('MCP 配置页后端会话展示', () => {
  it('扩展未挂上时显示运行中而不是连接失败', () => {
    expect(PANEL).toContain('mcpStatusPresentation');
    expect(PANEL).toContain('运行中 · 未挂上标签');
    expect(PANEL).toContain('backendSession === \'detached\'');
    expect(PANEL).toContain('dot-warn');
    expect(CSS).toContain('.config-status-dot.dot-warn');
  });
});
