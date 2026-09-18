import { describe, expect, it } from 'vitest';
import { buildMcpRuntimeContext } from '../../src/mcp/mcp-runtime-context.js';
import type { MCPManager } from '../../src/mcp/mcp-manager.js';
import type { MCPServerInfo } from '../../src/mcp/types.js';

function fakeManager(infos: MCPServerInfo[]): MCPManager {
  return { getServerInfos: () => infos } as MCPManager;
}

function readyServer(
  name: string,
  tools: string[],
): MCPServerInfo {
  return {
    name,
    config: { command: 'npx' },
    status: 'ready',
    tools: tools.map((toolName) => ({
      name: toolName,
      inputSchema: { type: 'object' },
    })),
  };
}

describe('buildMcpRuntimeContext', () => {
  it('ready 时也注入扩展断连与 browsermcp/puppeteer 分流，不只在 server error 时出现', () => {
    const ctx = buildMcpRuntimeContext(
      fakeManager([
        readyServer('browsermcp', ['browser_navigate', 'browser_snapshot']),
        readyServer('puppeteer', ['puppeteer_navigate', 'puppeteer_screenshot']),
      ]),
      [
        'mcp_browsermcp_browser_navigate',
        'mcp_puppeteer_puppeteer_navigate',
      ],
    );

    expect(ctx.mcpServers).toContain('ready = MCP process is up');
    expect(ctx.mcpRetryHint).toContain('No connection to browser extension');
    expect(ctx.mcpRetryHint).toContain('Prefer extension-browser MCP');
    expect(ctx.mcpRetryHint).not.toMatch(/unconfigured when mcp_\* tools are listed above/i);
    expect(ctx.mcpFailures).toBeUndefined();
  });

  it('服务器 error 时仍带 mcpFailures，且保留重试提示', () => {
    const ctx = buildMcpRuntimeContext(
      fakeManager([{
        name: 'puppeteer',
        config: { command: 'npx' },
        status: 'error',
        tools: [],
        error: 'spawn npx ENOENT',
      }]),
      [],
    );
    expect(ctx.mcpFailures).toContain('puppeteer');
    expect(ctx.mcpRetryHint).toContain('PUPPETEER_EXECUTABLE_PATH');
  });

  it('browsermcp detached 时进程行带 attach 说明，puppeteer 行保持原 ready 格式', () => {
    const ctx = buildMcpRuntimeContext(
      fakeManager([
        {
          ...readyServer('browsermcp', ['browser_navigate']),
          backendKind: 'browser_extension',
          backendSession: 'detached',
        },
        readyServer('puppeteer', ['puppeteer_navigate']),
      ]),
      ['mcp_browsermcp_browser_navigate', 'mcp_puppeteer_puppeteer_navigate'],
    );
    expect(ctx.mcpServers).toContain('browser session: detached');
    expect(ctx.mcpServers).toMatch(/puppeteer: ready \(1 tools\)/);
    expect(ctx.mcpRetryHint).toContain('browser session is detached');
    expect(ctx.mcpRetryHint).toContain('permanently switch to puppeteer');
  });
});
