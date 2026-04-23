/**
 * ice mcp — 查看 MCP Server 状态。
 */

import type { BootstrapResult } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { c, table } from '../utils/terminal-ui.js';

export async function runMcp(ctx: BootstrapResult, _args: ParsedArgs): Promise<void> {
  const infos = ctx.mcpManager.getServerInfos();

  if (infos.length === 0) {
    console.log(`\n${c.dim}未配置 MCP Server。在 data/config.json 的 mcpServers 字段添加配置。${c.reset}\n`);
    return;
  }

  console.log(`\n${c.bold}MCP Server 状态${c.reset}\n`);

  const statusIcon: Record<string, string> = {
    ready: `${c.green}●${c.reset}`,
    starting: `${c.yellow}●${c.reset}`,
    error: `${c.red}●${c.reset}`,
    stopped: `${c.dim}●${c.reset}`,
  };

  const rows = infos.map((s) => [
    `${statusIcon[s.status] || '?'} ${s.name}`,
    s.status,
    String(s.tools.length),
    s.error || '-',
  ]);

  table(['Server', '状态', '工具数', '错误'], rows);

  // 列出每个 Server 的工具
  for (const s of infos) {
    if (s.tools.length > 0) {
      console.log(`\n${c.bold}${s.name}${c.reset} 的工具:`);
      for (const t of s.tools) {
        console.log(`  ${c.cyan}${t.name}${c.reset} — ${(t.description || '').substring(0, 60)}`);
      }
    }
  }

  console.log('');
}
