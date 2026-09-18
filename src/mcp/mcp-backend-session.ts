/**
 * MCP 后端会话（与进程 status 正交）。
 *
 * 只识别「浏览器扩展」这一类后端（browsermcp）。puppeteer / HTTP / 其它 stdio
 * 服务器不走这里，避免把工具级失败误标成进程故障。
 */

export type McpBackendKind = 'none' | 'browser_extension';
export type McpBackendSession = 'unknown' | 'attached' | 'detached';

export interface McpBackendState {
  kind: McpBackendKind;
  session: McpBackendSession;
  lastError?: string;
}

const BROWSER_EXT_DETACHED_RE =
  /no connection to browser extension|not connected to (?:a )?browser(?: extension)?|browser extension is not connected/i;

export const BROWSER_EXTENSION_DETACHED_HINT = [
  'MCP process is still ready. This is a browser-extension attach error, not a missing/unconfigured server.',
  'Retry this same mcp_* tool once. If it still fails, ask the user to attach the Browser MCP extension to the tab.',
  'Do not switch to puppeteer as a permanent replacement while this server stays ready.',
].join(' ');

export function isBrowserExtensionMcp(
  serverName: string,
  toolNames: readonly string[] = [],
): boolean {
  if (/puppeteer/i.test(serverName)) return false;
  if (/browsermcp|browser[-_]?mcp/i.test(serverName)) return true;
  return toolNames.some((tool) =>
    !/puppeteer/i.test(tool)
    && /^(browser_navigate|browser_snapshot|browser_click|browser_type|browser_screenshot|browser_hover|browser_select_option|browser_press_key|browser_wait|browser_get_console_logs)$/i.test(tool),
  );
}

export function isBrowserExtensionDetachedError(text: string): boolean {
  return BROWSER_EXT_DETACHED_RE.test(text);
}

export function createMcpBackendState(
  serverName: string,
  toolNames: readonly string[] = [],
): McpBackendState {
  return {
    kind: isBrowserExtensionMcp(serverName, toolNames) ? 'browser_extension' : 'none',
    session: 'unknown',
  };
}

export function applyMcpToolOutcome(
  prev: McpBackendState,
  outcome: { success: boolean; output: string },
): McpBackendState {
  if (prev.kind !== 'browser_extension') return prev;
  if (outcome.success) {
    return { kind: 'browser_extension', session: 'attached' };
  }
  if (isBrowserExtensionDetachedError(outcome.output)) {
    return {
      kind: 'browser_extension',
      session: 'detached',
      lastError: outcome.output.slice(0, 400),
    };
  }
  return prev;
}

export function annotateBrowserExtensionDetachedOutput(output: string): string {
  const body = output.trim() || 'No connection to browser extension';
  if (body.includes('MCP process is still ready')) return body;
  return `${body}\n\n${BROWSER_EXTENSION_DETACHED_HINT}`;
}

export function formatMcpBackendRuntimeNote(state: McpBackendState | undefined): string {
  if (!state || state.kind !== 'browser_extension') return '';
  if (state.session === 'detached') {
    return ', browser session: detached — attach the extension to the tab';
  }
  if (state.session === 'attached') {
    return ', browser session: attached';
  }
  return ', browser session: unknown';
}
