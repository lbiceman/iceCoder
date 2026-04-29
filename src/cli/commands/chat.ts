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
import { c, info, success, warn, error, toolCall, toolResult, aiText, divider, Spinner } from '../utils/terminal-ui.js';
import { Harness } from '../../harness/harness.js';
import type { HarnessConfig } from '../../harness/types.js';
import { loadMemoryPrompt } from '../../memory/file-memory/index.js';
import { createFileMemoryManager } from '../../memory/file-memory/file-memory-manager.js';
import type { UnifiedMessage } from '../../llm/types.js';
import { registerGracefulShutdown } from '../graceful-shutdown.js';
import { formatFriendlyError } from '../friendly-errors.js';

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
 * 检测 cloudflared 是否可用。
 */
async function findCloudflared(customBin?: string): Promise<string | null> {
  const candidates = [
    customBin,
    process.env.CLOUDFLARED_BIN,
    'E:\\tools\\cloudflared\\cloudflared.exe', // 本地开发环境
    'cloudflared', // PATH 中查找
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`${bin} --version`, { stdio: 'ignore', timeout: 5000 });
      return bin;
    } catch {
      // 不可用，继续尝试下一个
    }
  }
  return null;
}

/**
 * 启动 Cloudflare Tunnel 子进程。
 * 如果 cloudflared 不存在，提示用户下载并跳过。
 */
async function startTunnel(port: number, tunnelBin?: string): Promise<ChildProcess | null> {
  const bin = await findCloudflared(tunnelBin);

  if (!bin) {
    warn('未检测到 cloudflared，跳过公网隧道。');
    console.log(`
  ${c.bold}安装 cloudflared:${c.reset}
    Windows:  ${c.cyan}winget install cloudflare.cloudflared${c.reset}
    macOS:    ${c.cyan}brew install cloudflared${c.reset}
    Linux:    ${c.cyan}curl -fsSL https://pkg.cloudflare.com/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared${c.reset}
    手动下载: ${c.underline}https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${c.reset}

  安装后重新运行 ${c.green}iceCoder start${c.reset} 即可自动启用公网隧道。
  或使用 ${c.green}--tunnel-bin <路径>${c.reset} 指定 cloudflared 位置。
`);
    return null;
  }

  info(`启动 Cloudflare Tunnel: ${bin}`);

  const tunnelArgs = ['tunnel', '--url', `http://localhost:${port}`, '--metrics', '127.0.0.1:20241'];
  const child = spawn(bin, tunnelArgs, {
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
      return '你是 iceCoder，一个拥有工具能力的智能编程助手。根据用户需求自主决定使用哪些工具。回答使用中文。';
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
      tunnelProcess = await startTunnel(port, getFlagStr(args.flags, 'tunnel-bin'));
    }
  }

  // 初始化记忆系统
  let fileMemoryManager: ReturnType<typeof createFileMemoryManager> | null = null;

  try {
    fileMemoryManager = createFileMemoryManager({
      memory: { memoryDir: memoryFilesDir },
      enableAutoExtraction: true,
      enableAsyncPrefetch: true,
    });
    await fileMemoryManager.initialize();
  } catch { fileMemoryManager = null; }

  // 注册优雅退出（Ctrl+C / SIGTERM）
  // latestHarness 追踪最近一次对话的 Harness 实例，
  // 退出时 drain 确保后台记忆提取/Dream 完成。
  let latestHarness: InstanceType<typeof Harness> | null = null;

  registerGracefulShutdown({
    message: 'iceCoder 正在退出...',
    cleanups: [
      async () => {
        if (latestHarness) {
          await latestHarness.drainMemory(5000);
          latestHarness = null;
        }
      },
      () => { tunnelProcess?.kill(); },
      () => { serveResult?.cleanup(); },
      () => ctx.mcpManager.shutdown(),
    ],
  });

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
      rl.close();
      return;
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
  ${c.cyan}/export${c.reset}  导出记忆文件
  ${c.cyan}/memory${c.reset}  查看/管理记忆文件
  ${c.cyan}/help${c.reset}    显示此帮助
  ${c.cyan}/quit${c.reset}    退出
`);
      rl.prompt();
      return;
    }

    if (cmd === 'memory' || cmd.startsWith('memory ')) {
      try {
        const { promises: fsP } = await import('node:fs');
        const pathMod = await import('node:path');
        const { scanMemoryFiles } = await import('../../memory/file-memory/memory-scanner.js');
        const { validatePath, PathTraversalError } = await import('../../memory/file-memory/memory-security.js');

        const projDir = pathMod.default.resolve(memoryFilesDir);
        const userDir = pathMod.default.resolve(process.env.ICE_USER_MEMORY_DIR || 'data/user-memory');
        const memArgs = cmd.substring(6).trim(); // "memory" 后面的参数

        // ~memory view <filename>
        if (memArgs.startsWith('view ')) {
          const viewFilename = memArgs.substring(5).trim();
          if (!viewFilename) {
            error('用法: /memory view <文件名>');
            rl.prompt();
            return;
          }

          let found = false;
          for (const dir of [projDir, userDir]) {
            try {
              const filePath = validatePath(viewFilename, dir);
              const content = await fsP.readFile(filePath, 'utf-8');
              const level = dir === userDir ? '用户级' : '项目级';
              info(`📄 ${viewFilename} (${level})`);
              console.log(content);
              found = true;
              break;
            } catch (e) {
              if (e instanceof PathTraversalError) {
                error('路径安全验证失败');
                rl.prompt();
                return;
              }
            }
          }
          if (!found) {
            error(`记忆文件未找到: ${viewFilename}`);
          }
          rl.prompt();
          return;
        }

        // ~memory delete <filename>
        if (memArgs.startsWith('delete ')) {
          const delFilename = memArgs.substring(7).trim();
          if (!delFilename) {
            error('用法: /memory delete <文件名>');
            rl.prompt();
            return;
          }
          if (delFilename === 'MEMORY.md') {
            error('不能删除索引文件 MEMORY.md');
            rl.prompt();
            return;
          }

          let deleted = false;
          for (const dir of [projDir, userDir]) {
            try {
              const filePath = validatePath(delFilename, dir);
              await fsP.access(filePath);
              await fsP.unlink(filePath);
              success(`已删除记忆: ${delFilename}`);
              deleted = true;
              break;
            } catch (e) {
              if (e instanceof PathTraversalError) {
                error('路径安全验证失败');
                rl.prompt();
                return;
              }
              // 文件不在此目录，继续
            }
          }
          if (!deleted) {
            error(`记忆文件未找到: ${delFilename}`);
          }
          rl.prompt();
          return;
        }

        // ~memory (无参数) — 列出所有记忆
        const projMemories = await scanMemoryFiles(projDir, 200);
        const userMemories = await scanMemoryFiles(userDir, 50);
        const seenFilenames = new Set(projMemories.map(m => m.filename));
        const allMemories = [
          ...projMemories.map(m => ({ ...m, level: 'project' })),
          ...userMemories.filter(m => !seenFilenames.has(m.filename)).map(m => ({ ...m, level: 'user' })),
        ];

        if (allMemories.length === 0) {
          info('📭 暂无记忆文件。');
          rl.prompt();
          return;
        }

        info(`📋 记忆文件 (${allMemories.length} 个):`);
        for (let i = 0; i < allMemories.length; i++) {
          const m = allMemories[i];
          const typeTag = m.type ? `[${m.type}]` : '';
          const desc = m.description ? ` — ${m.description}` : '';
          const levelTag = m.level === 'user' ? ' (用户级)' : '';
          console.log(`  ${c.cyan}${i + 1}.${c.reset} ${typeTag} ${m.filename}${desc}${levelTag}`);
        }
        console.log(`\n  查看记忆: ${c.cyan}/memory view <文件名>${c.reset}`);
        console.log(`  删除记忆: ${c.cyan}/memory delete <文件名>${c.reset}`);
      } catch (e) {
        error(`记忆操作失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      rl.prompt();
      return;
    }

    if (cmd === 'export') {
      try {
        const { promises: fsP } = await import('node:fs');
        const pathMod = await import('node:path');
        const { gzip: gzipCb } = await import('node:zlib');
        const { promisify } = await import('node:util');
        const gzipFn = promisify(gzipCb);

        const projDir = pathMod.default.resolve(memoryFilesDir);
        const userDir = pathMod.default.resolve(process.env.ICE_USER_MEMORY_DIR || 'data/user-memory');

        // 扫描文件
        const scanDir = async (dir: string): Promise<string[]> => {
          try {
            const entries = await fsP.readdir(dir, { recursive: true });
            return entries.filter((e: any) => typeof e === 'string' && e.endsWith('.md')) as string[];
          } catch { return []; }
        };

        const projFiles = await scanDir(projDir);
        const userFiles = await scanDir(userDir);
        const total = projFiles.length + userFiles.length;

        if (total === 0) {
          info('没有可导出的记忆文件。');
          rl.prompt();
          return;
        }

        // 打包
        const entries: Array<{ rp: string; buf: Buffer }> = [];
        for (const f of projFiles) {
          entries.push({ rp: 'project/' + f.replace(/\\/g, '/'), buf: await fsP.readFile(pathMod.default.join(projDir, f)) });
        }
        for (const f of userFiles) {
          entries.push({ rp: 'user/' + f.replace(/\\/g, '/'), buf: await fsP.readFile(pathMod.default.join(userDir, f)) });
        }

        let size = 4;
        for (const e of entries) { size += 2 + Buffer.byteLength(e.rp) + 4 + e.buf.length; }
        const raw = Buffer.alloc(size);
        let off = 0;
        raw.writeUInt32BE(entries.length, off); off += 4;
        for (const e of entries) {
          const pb = Buffer.from(e.rp, 'utf-8');
          raw.writeUInt16BE(pb.length, off); off += 2;
          pb.copy(raw, off); off += pb.length;
          raw.writeUInt32BE(e.buf.length, off); off += 4;
          e.buf.copy(raw, off); off += e.buf.length;
        }

        const compressed = await gzipFn(raw);
        const date = new Date().toISOString().split('T')[0];
        const outPath = `icecoder-memory-${date}.gz`;
        await fsP.writeFile(outPath, compressed);

        success(`记忆导出完成: ${outPath} (${total} 个文件, ${(compressed.length / 1024).toFixed(1)} KB)`);
      } catch (e) {
        error(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
      }
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
          tokenBudget: 500000,
        },
        permissions: [
          { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要确认' },
        ],
        compactionThreshold: 40,
        compactionKeepRecent: 10,
        compactionEnableLLMSummary: true,
        memoryDir: memoryFilesDir,
        fileMemoryManager: fileMemoryManager ?? undefined,
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
      latestHarness = harness;

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

      // v4 被动确认：显示记忆提取通知
      const extractionNotices = harness.flushExtractionNotices();
      for (const notice of extractionNotices) {
        console.log(`${c.dim}${notice}${c.reset}`);
      }

      // 显示统计
      const state = result.loopState;
      if (state.totalToolCalls > 0) {
        console.log(`${c.dim}[${state.totalToolCalls} 次工具调用 | ${state.currentRound} 轮 | ↑${state.totalInputTokens} ↓${state.totalOutputTokens} tokens]${c.reset}`);
      }

    } catch (err) {
      spinner.stop();
      error(formatFriendlyError(err));
    }

    divider();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nBye!');
    // 优雅退出由 registerGracefulShutdown 处理
    tunnelProcess?.kill();
    serveResult?.cleanup();
    ctx.mcpManager.shutdown().catch(() => {});
    process.exit(0);
  });
}
