import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');

function readPublic(relativePath: string): string {
  return readFileSync(path.join(publicRoot, relativePath), 'utf-8');
}

describe('企业级 UI 主题体系', () => {
  it('明暗主题共享完整的语义化表面、交互和排版令牌', () => {
    const tokens = readPublic('css/tokens.css');
    const requiredTokens = [
      '--surface-page',
      '--surface-sidebar',
      '--surface-panel',
      '--surface-raised',
      '--surface-overlay',
      '--border-subtle',
      '--border-strong',
      '--interactive-hover',
      '--interactive-active',
      '--focus-ring',
      '--content-max-width',
      '--font-mono',
    ];

    for (const token of requiredTokens) {
      expect(tokens, `缺少 ${token}`).toContain(token);
    }
    expect(tokens).toMatch(/\[data-theme="dark"\][\s\S]*--surface-sidebar:/);
    expect(tokens).toMatch(/\[data-theme="light"\][\s\S]*--surface-sidebar:/);
  });

  it('主题切换只保留在设置页，不占用桌面侧栏', () => {
    const sidebar = readPublic('js/chat-session-sidebar.js');
    const settings = readPublic('js/config-page.js');

    expect(sidebar).not.toContain('chat-sidebar-theme-btn');
    expect(sidebar).not.toContain('shell.toggleTheme()');
    expect(settings).toContain('settings-theme-options');
    expect(settings).toContain('shell.setTheme(next)');
  });

  it('企业工作台样式包含键盘焦点和减少动态效果支持', () => {
    const styleEntry = readPublic('css/style.css');
    const enterprise = readPublic('css/enterprise.css');

    expect(styleEntry).toContain("@import url('./enterprise.css')");
    expect(enterprise).toContain(':focus-visible');
    expect(enterprise).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('聊天工作台关键控件具备清晰对比度和足够点击宽度', () => {
    const enterprise = readPublic('css/enterprise.css');

    expect(enterprise).toMatch(
      /\.chat-sidebar-mode-btn\[data-mode="adaptive"\][\s\S]*?color:\s*var\(--accent\)/,
    );
    expect(enterprise).toMatch(
      /\.message\.user \.msg-label[\s\S]*?color:\s*var\(--text-on-accent-muted\)/,
    );
    expect(enterprise).toMatch(
      /\.chat-messages::\-webkit-scrollbar[\s\S]*?width:\s*16px/,
    );
    expect(enterprise).toMatch(
      /\.chat-staircase-lines[\s\S]*?background:\s*transparent/,
    );
  });
});
