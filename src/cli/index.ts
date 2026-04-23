#!/usr/bin/env node
/**
 * iceCoder CLI 入口。
 *
 * 用法:
 *   ice chat              交互式终端对话（默认同时启动 Web 服务器）
 *   ice serve             仅启动 Web 服务器
 *   ice run "任务描述"     单次任务执行
 *   ice tools             列出所有可用工具
 *   ice mcp               查看 MCP Server 状态
 *   ice config             查看/管理配置
 *   ice help              显示帮助
 */

import { parseArgs } from './utils/args-parser.js';
import { hasFlag } from './utils/args-parser.js';
import { c, error } from './utils/terminal-ui.js';
import { bootstrap } from './bootstrap.js';

const HELP = `
${c.bold}${c.cyan}iceCoder${c.reset} — AI 编程助手 CLI

${c.bold}用法:${c.reset}
  ice chat [options]           交互式终端对话
  ice serve [options]          启动 Web 服务器
  ice run "任务" [options]     单次任务执行
  ice tools [--json]           列出所有可用工具
  ice mcp                      查看 MCP Server 状态
  ice config                   查看 LLM 提供者配置
  ice config set default <id>  切换默认 LLM 提供者
  ice help                     显示此帮助

${c.bold}chat 选项:${c.reset}
  --port, -p <n>     Web 服务器端口 (默认 3000)
  --no-serve         不启动 Web 服务器（纯终端模式）

${c.bold}serve 选项:${c.reset}
  --port, -p <n>     服务器端口 (默认 3000)

${c.bold}run 选项:${c.reset}
  --max-rounds <n>   最大循环轮次 (默认 100)
  --json             输出 JSON 格式结果

${c.bold}chat 内置命令:${c.reset}
  ~scan              显示手机连接二维码
  ~tools             列出可用工具
  ~clear             清空对话历史
  ~quit              退出
`;

async function main(): Promise<void> {
  const args = parseArgs();

  // 帮助
  if (args.command === 'help' || hasFlag(args.flags, 'help', 'h')) {
    console.log(HELP);
    return;
  }

  // 版本
  if (hasFlag(args.flags, 'version', 'v')) {
    console.log('iceCoder v1.0.0');
    return;
  }

  // config 命令不需要完整引导
  if (args.command === 'config') {
    const { runConfig } = await import('./commands/config.js');
    await runConfig(args);
    return;
  }

  // 无子命令默认进入 chat
  const command = args.command || 'chat';

  // 需要完整引导的命令
  const ctx = await bootstrap();

  switch (command) {
    case 'chat': {
      const { runChat } = await import('./commands/chat.js');
      await runChat(ctx, args);
      break;
    }
    case 'serve': {
      const { runServe } = await import('./commands/serve.js');
      await runServe(ctx, args);
      break;
    }
    case 'run': {
      const { runRun } = await import('./commands/run.js');
      await runRun(ctx, args);
      break;
    }
    case 'tools': {
      const { runTools } = await import('./commands/tools.js');
      await runTools(ctx, args);
      await ctx.mcpManager.shutdown();
      break;
    }
    case 'mcp': {
      const { runMcp } = await import('./commands/mcp.js');
      await runMcp(ctx, args);
      await ctx.mcpManager.shutdown();
      break;
    }
    default:
      error(`未知命令: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  error('启动失败: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
