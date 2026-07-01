/**
 * 将 MCP 运行时状态注入 Harness 动态上下文，避免技能引用 mcp_* 工具时模型误判「未配置」。
 */

import type { MCPManager } from './mcp-manager.js';

export function buildMcpRuntimeContext(
  mcpManager: MCPManager | undefined,
  registeredToolNames: readonly string[],
): Record<string, string> {
  if (!mcpManager) return {};

  const infos = mcpManager.getServerInfos();
  if (infos.length === 0) return {};

  const mcpToolNames = registeredToolNames.filter((name) => name.startsWith('mcp_'));
  const serverLines = infos.map((s) => {
    const err = s.error ? ` — ${s.error}` : '';
    if (s.status === 'ready' && s.tools.length > 0) {
      const names = s.tools.map((t) => `mcp_${s.name}_${t.name}`).join(', ');
      return `- ${s.name}: ready (${s.tools.length} tools) → ${names}`;
    }
    return `- ${s.name}: ${s.status}${err}`;
  });

  const out: Record<string, string> = {
    mcpServers: [
      'Configured MCP servers and registered tool names for this turn (call mcp_* tools directly when status is ready):',
      ...serverLines,
    ].join('\n'),
  };

  if (mcpToolNames.length > 0) {
    out.mcpToolsAvailableThisTurn = mcpToolNames.join(', ');
  } else {
    out.mcpToolsAvailableThisTurn =
      '(none registered this turn — check ~/.iceCoder/mcp.json; on desktop, npx-based servers need bundled deps or system Node.js; run GET /api/mcp for status)';
  }

  const failed = infos.filter((s) => s.status === 'error');
  if (failed.length > 0) {
    out.mcpFailures = failed
      .map((s) => `${s.name}: ${s.error ?? 'unknown error'}`)
      .join('; ');
    out.mcpRetryHint =
      'If an mcp_* call failed but the server shows ready, retry the same tool once. Do NOT claim MCP is unconfigured when mcp_* tools are listed above. For puppeteer, ensure Chrome is installed at PUPPETEER_EXECUTABLE_PATH in mcp.json.';
  }

  return out;
}
