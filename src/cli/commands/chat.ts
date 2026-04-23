/**
 * iceCoder chat/cli/start — 交互式终端对话。
 *
 * start 模式：CLI + Web + Cloudflare Tunnel 三合一
 * cli 模式：仅终端对话（--no-serve）
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BootstrapResult } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { getFlagNum, getFlagStr, hasFlag } from '../utils/args-parser.js';
import { startWebServer, type ServeResult } from './serve.js';
import { c, info, success, error, toolCall, toolResult, aiText, divider, Spinner } from '../utils/terminal-ui.js';
import { Harness } from '../../harness/harness.js';
import type { HarnessConfig } from '../../harness/types.js';
import { loadMemoryPrompt } from '../../memory/file-memory/index.js';
import { MemoryManager } from '../../memory/memory-manager.js';
import { createFileMemoryManager } from '../../memory/file-memory/file-memory-manager.js';
import type { UnifiedMessage } from '../../llm/types.js';

/**
 * 在终端显示 ASCII 二维码。
 */
async function showScanQR(port: number): Promise<void> {
  try {
    const os = await import('node:os');
    const interfaces = os.networkInterfaces();
    let localIP = '127.0.0.1';
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          localIP = addr.address;
          break;
        }
      }
      if (localIP !== '127.0.0.1') break;
    }

    // 尝试获取 cloudflared 隧道 URL
    let url = `http://${localIP}:${port}`;
    try {
      const res = await fetch('http://127.0.0.1:20241/quicktunnel', { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json() as { hostname?: string };
        if (data.hostname) {
          url = `https://${data.hostname}`;
        }
      }
    } catch { /* no tunnel */ }

    const QRCode = await import('qrcode');
    const qrText = await QRCode.default.toString(url, { type: 'terminal', small: true });

    console.log('');
    console.log(qrText);
    info(`📱 手机扫码连接: ${c.underline}${url}${c.reset}`);
    console.log('');
  } catch (err) {
    error('生成二维码失败: ' + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * 启动 Cloudflare Tunnel 子进程。
 */
function startTunnel(port: number, tunnelBin?: string): ChildProcess {
  const bin = tunnelBin || process.env.CLOUDFLARED_BIN || 'cloudflared';
  const args = ['tunnel', '--url', `http://localhost:${port}`, '--metrics', '127.0.0.1:20241'];

  info(`启动 Cloudflare Tunnel: ${bin}`);

  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    // 提取隧道 URL
    const urlMatch = msg.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (urlMatch) {
      info(`🌐 公网地址: ${c.underline}${urlMatch[0]}${c.reset}`);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    const urlMatch = msg.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (urlMatch) {
      info(`🌐 公网地址: ${c.underline}${urlMatch[0]}${c.reset}`);
    }
  });

  child.on('error', (err) => {
    error(`Cloudflare Tunnel 启动失败: ${err.message}`);
    info('可通过 --no-tunnel 跳过，或 --tunnel-bin 指定 cloudflared 路径');
  });

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      error(`Cloudflare Tunnel 退出 (code: ${code})`);
    }
  });

  return child;
}

/**
 * iceCoder chat/cli/start 命令入口。
 */
export async function runChat(ctx: BootstrapResult, args: ParsedArgs): Promise<void> {
  const noServe = hasFlag(args.flags, 'no-serve');
  const withTunnel = hasFlag(args.flags, 'with-tunnel');
  const port = getFlagNum(args.flags, 'port', 'p') ?? parseInt(process.env.PORT ?? '3000', 10);
  const { systemPromptPath, memoryFilesDir } = ctx.paths;

  /** 加载系统提示词 */
  async function loadSystemPrompt(): Promise<string> {
    try {
      return await fs.readFile(systemPromptPath, 'utf-8');
    } catch {
      return '你是一个智能助手，拥有工具能力。根据用户需求自主决定使用哪些工具。回答使用中文。';
    }
  }

  // 启动 Web 服务器（除非 --no-serve）
  let serveResult: ServeResult | null = null;
  let tunnelProcess: ChildProcess | null = null;

  if (!noServe) {
    serveResult = await startWebServer(ctx, port);
    info(`Web 服务器已启动: ${c.underline}http://localhost:${port}${c.reset}`);

    // 启动 Cloudflare Tunnel（start 模式）
    if (withTunnel && !hasFlag(args.flags, 'no-tunnel')) {
      tunnelProcess = startTunnel(port, getFlagStr(args.flags, 'tunnel-bin'));
    }
  }

  // 初始化记忆系统
  let fileMemoryManager: ReturnType<typeof createFileMemoryManager> | null = null;
  let memoryManager: MemoryManager | null = null;

  try {
    fileMemoryManager = createFileMemoryManager({
      memory: { memoryDir: memoryFilesDir },
      enableAutoExtraction: true,
      enableAsyncPrefetch: true,
    });
    await fileMemoryManager.initialize();
  } catch { fileMemoryManager = null; }

  try {
    memoryManager = new MemoryManager();
  } catch { memoryManager = null; }

  // 会话消息历史（跨轮次累积）
  let sessionMessages: UnifiedMessage[] | undefined;

  // 打印欢迎信息
  console.log('');
  console.log(`${c.bold}${c.cyan}iceCoder${c.reset} ${c.dim}v1.0.0${c.reset}`);
  console.log(`${c.dim}工具: ${ctx.toolRegistry.getAll().length} 个内置${ctx.mcpManager.totalTools > 0 ? ` + ${ctx.mcpManager.totalTools} 个 MCP` : ''}${c.reset}`);
  if (serveResult) {
    console.log(`${c.dim}输入 /scan 显示手机连接二维码${c.reset}`);
  }
  console.log(`${c.dim}输入 /help 查看命令，/quit 退出${c.reset}`);
  divider();

  // 创建 readline 接口
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.green}iceCoder>${c.reset} `,
    terminal: process.stdin.isTTY ?? false,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // 内置命令（支持 ~cmd 和 /cmd 两种前缀）
    const cmd = input.startsWith('~') ? input.substring(1) : input.startsWith('/') ? input.substring(1) : '';

    if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
      console.log('Bye!');
      tunnelProcess?.kill();
      serveResult?.cleanup();
      ctx.mcpManager.shutdown().catch(() => {});
      process.exit(0);
    }

    if (cmd === 'scan') {
      if (serveResult) {
        await showScanQR(port);
      } else {
        error('Web 服务器未启动，无法生成二维码。移除 --no-serve 参数后重试。');
      }
      rl.prompt();
      return;
    }

    if (cmd === 'tools') {
      const tools = ctx.toolRegistry.getAll();
      info(`共 ${tools.length} 个工具:`);
      for (const t of tools) {
        console.log(`  ${c.cyan}${t.definition.name}${c.reset} — ${t.definition.description.substring(0, 60)}`);
      }
      rl.prompt();
      return;
    }

    if (cmd === 'clear') {
      sessionMessages = undefined;
      success('对话历史已清空');
      rl.prompt();
      return;
    }

    if (cmd === 'help') {
      console.log(`
${c.bold}终端内置命令:${c.reset}
  ${c.cyan}/scan${c.reset}    显示手机连接二维码
  ${c.cyan}/tools${c.reset}   列出可用工具
  ${c.cyan}/clear${c.reset}   清空对话历史
  ${c.cyan}/help${c.reset}    显示此帮助
  ${c.cyan}/quit${c.reset}    退出
`);
      rl.prompt();
      return;
    }

    // 发送给 AI
    const spinner = new Spinner('思考中...');
    spinner.start();

    try {
      const systemPrompt = await loadSystemPrompt();
      const toolDefs = ctx.toolRegistry.getDefinitions();

      const harnessConfig: HarnessConfig = {
        context: {
          systemPrompt,
          tools: toolDefs,
          memoryPrompt: await loadMemoryPrompt({ memoryDir: memoryFilesDir }) ?? undefined,
        },
        loop: {
          maxRounds: 200,
          timeout: 30 * 60 * 1000,
          tokenBudget: 300000,
        },
        permissions: [
          { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要确认' },
        ],
        compactionThreshold: 40,
        compactionKeepRecent: 10,
        compactionEnableLLMSummary: true,
        memoryDir: memoryFilesDir,
        fileMemoryManager: fileMemoryManager ?? undefined,
        memoryManager: memoryManager ?? undefined,
        onConfirm: async (toolName, toolArgs) => {
          // 终端确认
          spinner.stop();
          const argsStr = JSON.stringify(toolArgs).substring(0, 100);
          console.log(`\n${c.yellow}⚠ 需要确认: ${toolName}(${argsStr})${c.reset}`);

          return new Promise<boolean>((resolve) => {
            const confirmRl = createInterface({ input: process.stdin, output: process.stdout });
            confirmRl.question(`${c.yellow}允许执行? (y/n) ${c.reset}`, (answer) => {
              confirmRl.close();
              resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
            });
          });
        },
      };

      const harness = new Harness(harnessConfig, ctx.toolExecutor);

      spinner.stop();

      const result = await harness.run(
        input,
        (msgs, opts) => ctx.llmAdapter.chat(msgs, opts),
        (event) => {
          if (event.type === 'thinking' && event.content) {
            // 思考内容（部分模型会返回）
          }
          if (event.type === 'tool_call' && event.toolName) {
            const argsStr = event.toolArgs ? JSON.stringify(event.toolArgs) : '';
            toolCall(event.toolName, argsStr);
          }
          if (event.type === 'tool_result') {
            toolResult(event.toolSuccess ?? false);
          }
        },
        sessionMessages,
      );

      // 更新会话历史
      sessionMessages = result.messages;

      // 输出 AI 回复
      if (result.content) {
        aiText(result.content);
      }

      // 显示统计
      const state = result.loopState;
      if (state.totalToolCalls > 0) {
        console.log(`${c.dim}[${state.totalToolCalls} 次工具调用 | ${state.currentRound} 轮 | ↑${state.totalInputTokens} ↓${state.totalOutputTokens} tokens]${c.reset}`);
      }

    } catch (err) {
      spinner.stop();
      error('执行失败: ' + (err instanceof Error ? err.message : String(err)));
    }

    divider();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nBye!');
    tunnelProcess?.kill();
    serveResult?.cleanup();
    ctx.mcpManager.shutdown().catch(() => {});
    process.exit(0);
  });
}
