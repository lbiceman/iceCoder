/**
 * ice tools — 列出所有可用工具。
 */

import type { BootstrapResult } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { hasFlag } from '../utils/args-parser.js';
import { c, table } from '../utils/terminal-ui.js';
import { getToolMetadata } from '../../tools/tool-metadata.js';

export async function runTools(ctx: BootstrapResult, _args: ParsedArgs): Promise<void> {
  const tools = ctx.toolRegistry.getAll();
  const json = hasFlag(_args.flags, 'json');

  if (json) {
    const list = tools.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
    }));
    console.log(JSON.stringify(list, null, 2));
    return;
  }

  console.log(`\n${c.bold}可用工具 (${tools.length})${c.reset}\n`);

  const rows = tools.map((t) => {
    const meta = getToolMetadata(t.definition.name);
    const tags = meta.tags.join(', ') || '-';
    const desc = t.definition.description.substring(0, 50);
    const isMcp = t.definition.name.startsWith('mcp_');
    const name = isMcp
      ? `${c.magenta}${t.definition.name}${c.reset}`
      : `${c.cyan}${t.definition.name}${c.reset}`;
    return [name, tags, desc];
  });

  table(['工具名', '分类', '说明'], rows);
  console.log('');

  if (ctx.mcpManager.totalTools > 0) {
    console.log(`${c.dim}其中 ${ctx.mcpManager.totalTools} 个来自 MCP Server${c.reset}`);
  }
}
