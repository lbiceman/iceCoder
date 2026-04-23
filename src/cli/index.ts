#!/usr/bin/env node
/**
 * iceCoder CLI 入口。
 *
 * 用法:
 *   iceCoder start             启动全部（CLI + Web + Cloudflare Tunnel）
 *   iceCoder cli               仅终端交互式对话
 *   iceCoder web               仅启动 Web 服务器
 *   iceCoder run "任务描述"     单次任务执行
 *   iceCoder tools             列出所有可用工具
 *   iceCoder mcp               查看 MCP Server 状态
 *   iceCoder config            查看/管理配置
 *   iceCoder help              显示帮助
 */

import { parseArgs } from './utils/args-parser.js';
import { hasFlag } from './utils/args-parser.js';
import { c, error } from './utils/terminal-ui.js';
import { bootstrap } from './bootstrap.js';

const HELP = `
${c.bold}${c.cyan}iceCoder${c.reset} — AI 编程助手 CLI

${c.bold}用法:${c.reset}
  iceCoder start [options]          启动全部（CLI + Web + Cloudflare Tunnel）
  iceCoder cli [options]            仅终端交互式对话
  iceCoder web [options]            仅启动 Web 服务器
  iceCoder run "任务" [options]     单次任务执行
  iceCoder tools [--json]           列出所有可用工具
  iceCoder mcp                      查看 MCP Server 状态
  iceCoder config                   查看 LLM 提供者配置
  iceCoder config set default <id>  切换默认 LLM 提供者
  iceCoder help                     显示此帮助

${c.bold}start/cli/web 选项:${c.reset}
  --port, -p <n>       Web 服务器端口 (默认 3000)
  --no-tunnel          不启动 Cloudflare Tunnel (仅 start)
  --tunnel-bin <path>  cloudflared 可执行文件路径

${c.bold}run 选项:${c.reset}
  --max-rounds <n>   最大循环轮次 (默认 100)
  --json             输出 JSON 格式结果

${c.bold}终端内置命令 (cli/start 模式):${c.reset}
  /scan              显示手机连接二维码
  /tools             列出可用工具
  /clear             清空对话历史
  /help              显示命令帮助
  /quit              退出
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

  // 无子命令默认 start
  const command = args.command || 'start';

  // 需要完整引导的命令
  const ctx = await bootstrap();

  // 首次运行提示
  if (ctx.isFirstRun) {
    console.log(`
${c.bold}${c.yellow}首次运行！${c.reset}

已在 ${c.underline}${ctx.paths.dataDir}${c.reset} 创建默认配置。

${c.bold}下一步：${c.reset}
  1. 编辑 ${c.cyan}${ctx.paths.configPath}${c.reset}
  2. 将 ${c.yellow}sk-your-api-key-here${c.reset} 替换为你的 API Key
  3. 可选：修改 apiUrl 和 modelName 使用其他模型（如 DeepSeek）
  4. 重新运行 ${c.green}iceCoder start${c.reset}
`);
    process.exit(0);
  }

  switch (command) {
    case 'start': {
      // CLI + Web + Cloudflare Tunnel 三合一
      const { runChat } = await import('./commands/chat.js');
      args.flags['with-tunnel'] = true;
      await runChat(ctx, args);
      break;
    }
    case 'cli':
    case 'chat': {
      // 仅终端对话（不启动 Web）
      const { runChat } = await import('./commands/chat.js');
      args.flags['no-serve'] = true;
      await runChat(ctx, args);
      break;
    }
    case 'web':
    case 'serve': {
      // 仅 Web 服务器
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
