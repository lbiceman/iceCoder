/**
 * 将 MCP 运行时状态注入 Harness 动态上下文，避免技能引用 mcp_* 工具时模型误判「未配置」。
 */

import type { MCPManager } from './mcp-manager.js';
import {
  formatMcpBackendRuntimeNote,
  isBrowserExtensionMcp,
} from './mcp-backend-session.js';

function sanitizeRuntimeName(value: string): string {
  return value.replace(/[\r\n<>`]/g, '_').slice(0, 120);
}

function sanitizeRuntimeError(value: string | undefined): string {
  return (value ?? 'unknown error')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .slice(0, 500);
}

function looksLikePuppeteerServer(name: string, toolNames: readonly string[]): boolean {
  if (/puppeteer/i.test(name)) return true;
  return toolNames.some((tool) => /puppeteer/i.test(tool));
}

export function buildMcpRuntimeContext(
  mcpManager: MCPManager | undefined,
  registeredToolNames: readonly string[],
): Record<string, string> {
  if (!mcpManager) return {};

  const infos = mcpManager.getServerInfos();
  if (infos.length === 0) return {};

  const mcpToolNames = registeredToolNames.filter((name) => name.startsWith('mcp_'));
  const serverLines = infos.map((s) => {
    const serverName = sanitizeRuntimeName(s.name);
    const err = s.error ? ` — ${sanitizeRuntimeError(s.error)}` : '';
    if (s.status === 'ready' && s.tools.length > 0) {
      const names = s.tools
        .map((t) => `mcp_${serverName}_${sanitizeRuntimeName(t.name)}`)
        .join(', ');
      const backendNote = formatMcpBackendRuntimeNote({
        kind: s.backendKind === 'browser_extension' ? 'browser_extension' : 'none',
        session: s.backendSession ?? 'unknown',
      });
      if (backendNote) {
        return `- ${serverName}: ready (process${backendNote}) (${s.tools.length} tools) → ${names}`;
      }
      return `- ${serverName}: ready (${s.tools.length} tools) → ${names}`;
    }
    return `- ${serverName}: ${s.status}${err}`;
  });

  const out: Record<string, string> = {
    mcpServers: [
      'Configured MCP servers and registered tool names for this turn (call listed mcp_* tools directly when status is ready).',
      'ready = MCP process is up, not that every backend (browser extension, Chrome) is attached.',
      ...serverLines,
    ].join('\n'),
  };

  if (mcpToolNames.length > 0) {
    out.mcpToolsAvailableThisTurn = mcpToolNames.join(', ');
  } else {
    out.mcpToolsAvailableThisTurn =
      '(none registered this turn — check ~/.iceCoder/mcp.json; on desktop, npx-based servers need bundled deps or system Node.js; run GET /api/mcp for status)';
  }

  const hasBrowserExt = infos.some((s) =>
    s.backendKind === 'browser_extension'
    || isBrowserExtensionMcp(s.name, s.tools.map((t) => t.name)),
  );
  const hasPuppeteer = infos.some((s) =>
    looksLikePuppeteerServer(s.name, s.tools.map((t) => t.name)),
  );
  const hasDetachedBrowser = infos.some((s) =>
    s.backendKind === 'browser_extension' && s.backendSession === 'detached',
  );
  if (mcpToolNames.length > 0 || hasBrowserExt || hasPuppeteer) {
    const hints: string[] = [];
    if (hasDetachedBrowser) {
      hints.push(
        'A listed extension-browser MCP is ready but its browser session is detached. Retry the same mcp_*browser_* tool; do not claim the server is unconfigured or permanently switch to puppeteer.',
      );
    } else {
      hints.push(
        'If an mcp_* call failed but that server is still ready, retry the same tool once. Do not claim MCP is unconfigured.',
      );
    }
    if (hasBrowserExt) {
      hints.push(
        'If the error is "No connection to browser extension", that is a tab-attach error. Retry the same extension-browser tool once, then ask the user to attach the extension.',
      );
    }
    if (hasBrowserExt && hasPuppeteer) {
      hints.push(
        'Prefer extension-browser MCP (browsermcp / browser_*) for the page the user is looking at. Puppeteer is a separate Chrome fallback after that retry, not a permanent replacement.',
      );
    } else if (hasPuppeteer) {
      hints.push('For puppeteer, ensure Chrome is installed at PUPPETEER_EXECUTABLE_PATH in mcp.json.');
    }
    out.mcpRetryHint = hints.join(' ');
  }

  const failed = infos.filter((s) => s.status === 'error');
  if (failed.length > 0) {
    out.mcpFailures = failed
      .map((s) => `${sanitizeRuntimeName(s.name)}: ${sanitizeRuntimeError(s.error)}`)
      .join('; ');
  }

  return out;
}
