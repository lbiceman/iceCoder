import { describe, expect, it } from 'vitest';

import {
  annotateBrowserExtensionDetachedOutput,
  applyMcpToolOutcome,
  createMcpBackendState,
  formatMcpBackendRuntimeNote,
  isBrowserExtensionDetachedError,
  isBrowserExtensionMcp,
} from '../../src/mcp/mcp-backend-session.js';

describe('mcp-backend-session', () => {
  it('只把 browsermcp / browser_* 当成扩展浏览器，不影响 puppeteer 与其它 MCP', () => {
    expect(isBrowserExtensionMcp('browsermcp', ['browser_navigate'])).toBe(true);
    expect(isBrowserExtensionMcp('user-browsermcp', ['browser_snapshot'])).toBe(true);
    expect(isBrowserExtensionMcp('github', ['create_issue'])).toBe(false);
    expect(isBrowserExtensionMcp('puppeteer', ['puppeteer_navigate'])).toBe(false);
    expect(isBrowserExtensionMcp('chrome-devtools', ['puppeteer_screenshot'])).toBe(false);
    expect(isBrowserExtensionMcp('chrome-devtools', ['navigate_page', 'take_snapshot'])).toBe(false);
    expect(createMcpBackendState('puppeteer', ['puppeteer_navigate']).kind).toBe('none');
    expect(createMcpBackendState('browsermcp', ['browser_click']).kind).toBe('browser_extension');
  });

  it('只把扩展断连文案标成 detached，不误伤 puppeteer 网络错误', () => {
    expect(isBrowserExtensionDetachedError('No connection to browser extension')).toBe(true);
    expect(isBrowserExtensionDetachedError('MCP error [-32603]: No connection to browser extension')).toBe(true);
    expect(isBrowserExtensionDetachedError('net::ERR_CONNECTION_CLOSED at https://example.com/')).toBe(false);
    expect(isBrowserExtensionDetachedError('Chrome is not installed')).toBe(false);
  });

  it('成功调用后标 attached；扩展断连不改变 kind', () => {
    const start = createMcpBackendState('browsermcp', ['browser_navigate']);
    const detached = applyMcpToolOutcome(start, {
      success: false,
      output: 'No connection to browser extension',
    });
    expect(detached).toMatchObject({ kind: 'browser_extension', session: 'detached' });
    const attached = applyMcpToolOutcome(detached, {
      success: true,
      output: 'Navigated',
    });
    expect(attached).toEqual({ kind: 'browser_extension', session: 'attached' });

    const puppeteer = createMcpBackendState('puppeteer', ['puppeteer_navigate']);
    expect(applyMcpToolOutcome(puppeteer, {
      success: false,
      output: 'No connection to browser extension',
    })).toEqual(puppeteer);
  });

  it('给扩展断连输出补进程仍 ready 的说明', () => {
    const annotated = annotateBrowserExtensionDetachedOutput('No connection to browser extension');
    expect(annotated).toContain('MCP process is still ready');
    expect(annotated).toContain('Do not switch to another MCP server');
    expect(annotateBrowserExtensionDetachedOutput(annotated)).toBe(annotated);
    expect(formatMcpBackendRuntimeNote({ kind: 'browser_extension', session: 'detached' }))
      .toContain('attach the extension');
    expect(formatMcpBackendRuntimeNote({ kind: 'none', session: 'unknown' })).toBe('');
  });
});
