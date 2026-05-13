/**
 * ice mcp — 查看 MCP Server 状态。
 */

import type { BootstrapResult } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { c, table } from '../utils/terminal-ui.js';

export async function runMcp(ctx: BootstrapResult, _args: ParsedArgs): Promise<void> {
  const infos = ctx.mcpManager.getServerInfos();

  if (infos.length === 0) {
    console.log(`\n${c.dim}未配置 MCP Server（${c.cyan}.iceCoder/mcp.json${c.dim} 中无 mcpServers 或为空）。可参考 ${c.cyan}.iceCoder/mcp.example.json${c.dim}；将需启用的条目的 ${c.yellow}disabled${c.dim} 设为 false。环境变量 ${c.yellow}ICE_MCP_CONFIG_PATH${c.dim} 可覆盖配置文件路径。${c.reset}\n`);
    return;
  }

  const readyTools = infos.filter((s) => s.status === 'ready').reduce((n, s) => n + s.tools.length, 0);
  if (readyTools === 0) {
    console.log(`\n${c.yellow}提示：${c.reset} 以下 MCP 均已登记，但尚无 ${c.green}ready${c.reset} 的服务器（多为 ${c.dim}disabled${c.reset} 或启动失败）。启用前请安装 Node；${c.dim}uvx${c.reset} 类条目需本机已安装 Python/uv。\n`);
  }

  console.log(`\n${c.bold}MCP Server 状态${c.reset}\n`);

  const statusIcon: Record<string, string> = {
    ready: `${c.green}●${c.reset}`,
    starting: `${c.yellow}●${c.reset}`,
    error: `${c.red}●${c.reset}`,
    stopped: `${c.dim}●${c.reset}`,
    disabled: `${c.dim}○${c.reset}`,
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
