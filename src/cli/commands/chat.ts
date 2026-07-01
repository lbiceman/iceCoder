/**
 * iceCoder chat/cli/start — 交互式终端对话。
 *
 * start 模式：CLI + Web + Cloudflare Tunnel 三合一
 * cli 模式：仅终端对话（--no-serve）
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BootstrapResult } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { getFlagNum, getFlagStr, hasFlag } from '../utils/args-parser.js';
import { startWebServer, type ServeResult } from './serve.js';
import { resolveDefaultApiPort } from '../serve-port.js';
import { c, info, success, warn, error, toolCall, toolResult, aiText, divider, Spinner } from '../utils/terminal-ui.js';
import { Harness } from '../../harness/harness.js';
import type { HarnessConfig } from '../../harness/types.js';
import { resolveWorkspaceToolContext } from '../../harness/workspace-run-context.js';
import { buildMcpRuntimeContext } from '../../mcp/mcp-runtime-context.js';
import { loadMemoryPrompt } from '../../memory/file-memory/index.js';
import { createFileMemoryManager } from '../../memory/file-memory/file-memory-manager.js';
import type { UnifiedMessage } from '../../llm/types.js';
import { registerGracefulShutdown } from '../graceful-shutdown.js';
import { disposeAllBackgroundTaskManagers } from '../../tools/background-task-manager.js';
import { purgeAllUploadedFiles } from '../../web/routes/upload.js';
import { formatFriendlyError } from '../friendly-errors.js';
import { harnessOverlayToContextFields } from '../../prompts/prompt-assembler.js';
import { loadAssembledChatPrompt, shouldDisableRuntimeTools } from '../../prompts/load-chat-prompt.js';
import type { AssembledPrompt } from '../../prompts/types.js';
import { DEFAULT_SYSTEM_PROMPT } from '../paths.js';
import {
  getHarnessMaxRoundsFromEnv,
  getHarnessTimeoutMsFromEnv,
  getHarnessTokenBudget,
} from '../../harness/token-budget-config.js';
import { loadHarnessSupervisorRuntime } from '../../harness/supervisor/supervisor-config.js';
import {
  readSkipPermissionChecksFromMainConfig,
} from '../../config/main-config-supervisor-mode.js';
import { readVerificationExemptDirsFromMainConfig } from '../../harness/verification-exempt-config.js';
import { fetchQuickTunnelPublicUrl } from '../../web/quicktunnel-url.js';
import { startTunnel } from '../tunnel/cloudflared-tunnel.js';
import { isTunnelDevEnabled } from '../../runtime/tunnel-feature.js';

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

    let url = `http://${localIP}:${port}`;
    if (isTunnelDevEnabled()) {
      const tunnelUrl = await fetchQuickTunnelPublicUrl();
      if (tunnelUrl) url = tunnelUrl;
    }

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
 * iceCoder chat/cli/start 命令入口。
 */
export async function runChat(ctx: BootstrapResult, args: ParsedArgs): Promise<void> {
  const noServe = hasFlag(args.flags, 'no-serve');
  const withTunnel = hasFlag(args.flags, 'with-tunnel');
  const port = getFlagNum(args.flags, 'port', 'p') ?? resolveDefaultApiPort();
  const { memoryFilesDir } = ctx.paths;

  /** 加载提示词（与 WebSocket 共用逻辑；不绑定固定自然语言）。 */
  async function loadAssembledPrompt(): Promise<AssembledPrompt> {
    return loadAssembledChatPrompt({
      logPrefix: '[cli]',
      systemPromptPath: ctx.paths.systemPromptPath,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
  }

  // 启动 Web 服务器（除非 --no-serve）
  let serveResult: ServeResult | null = null;
  let tunnelProcess: ChildProcess | null = null;

  if (!noServe) {
    serveResult = await startWebServer(ctx, port);
    info(`Web 服务器已启动: ${c.underline}http://127.0.0.1:${port}${c.reset}`);

    if (
      isTunnelDevEnabled() &&
      withTunnel &&
      !hasFlag(args.flags, 'no-tunnel') &&
      !ctx.needsSetup
    ) {
      tunnelProcess = await startTunnel(port, getFlagStr(args.flags, 'tunnel-bin'));
    }
  }

  // 注册优雅退出（Ctrl+C / SIGTERM）
  // latestHarness 追踪最近一次对话的 Harness 实例，
  // 退出时 drain 确保后台记忆提取/Dream 完成。
  let latestHarness: InstanceType<typeof Harness> | null = null;

  const triggerShutdown = registerGracefulShutdown({
    message: 'iceCoder 正在退出...',
    cleanups: [
      async () => {
        if (latestHarness) {
          await latestHarness.drainMemory(5000);
          latestHarness = null;
        }
      },
      () => { disposeAllBackgroundTaskManagers(); },
      () => { purgeAllUploadedFiles(); },
      () => { tunnelProcess?.kill(); },
      () => { serveResult?.cleanup(); },
      () => ctx.mcpManager.shutdown(),
    ],
  });

  if (ctx.needsSetup) {
    if (!noServe) {
      warn('首次使用：请在浏览器中完成模型配置');
      console.log(`  ${c.cyan}http://127.0.0.1:${port}/#/config${c.reset}`);
      return;
    }
    error('请先完成模型配置后再使用终端对话');
    process.exit(1);
  }

  // F2: dual-mode 全局策略一次性加载，每次对话复用，避免每轮多读磁盘。
  const supervisorRuntime = await loadHarnessSupervisorRuntime({
    dataDir: ctx.paths.dataDir,
    mainConfigPath: ctx.paths.configPath,
  });

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
      // 走优雅退出（含 drainMemory / 后台任务释放 / 关闭超时），
      // 关闭 readline 由 shutdown 的 process.exit 收尾。
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

    const spinner = new Spinner('思考中...');
    spinner.start();

    try {
      const assembled = await loadAssembledPrompt();
      let toolDefs = shouldDisableRuntimeTools() ? [] : ctx.toolRegistry.getDefinitions();

      const skipPermissionChecks = await readSkipPermissionChecksFromMainConfig(ctx.paths.configPath);
      const verificationExemptDirs = await readVerificationExemptDirsFromMainConfig(ctx.paths.configPath);

      const wsCtx = await resolveWorkspaceToolContext({
        sessionDir: ctx.paths.sessionsDir,
        sessionId: 'default',
        userMessage: input,
        defaultWorkDir: process.cwd(),
        defaultToolExecutor: ctx.toolExecutor,
        defaultToolRegistry: ctx.toolRegistry,
        fileParser: ctx.fileParser,
        llmAdapter: ctx.llmAdapter,
        mcpManager: ctx.mcpManager,
      });
      toolDefs = shouldDisableRuntimeTools() ? [] : wsCtx.toolDefs;
      const mcpRuntimeContext = buildMcpRuntimeContext(
        ctx.mcpManager,
        toolDefs.map((t) => t.name),
      );

      const harnessConfig: HarnessConfig = {
        context: {
          systemPrompt: assembled.systemPrompt,
          tools: toolDefs,
          memoryPrompt: await loadMemoryPrompt({ memoryDir: memoryFilesDir }) ?? undefined,
          ...harnessOverlayToContextFields(assembled),
          ...(Object.keys(mcpRuntimeContext).length > 0 ? { systemContext: mcpRuntimeContext } : {}),
        },
        loop: {
          maxRounds: getHarnessMaxRoundsFromEnv(),
          timeout: getHarnessTimeoutMsFromEnv(),
          tokenBudget: getHarnessTokenBudget(),
        },
        permissions: [
          { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要确认' },
        ],
        skipPermissionChecks,
        compactionThreshold: 40,
        compactionKeepRecent: 10,
        compactionEnableLLMSummary: true,
        memoryDir: memoryFilesDir,
        fileMemoryManager: fileMemoryManager ?? undefined,
        sessionDir: ctx.paths.sessionsDir,
        sessionId: 'default',
        workspaceRoot: wsCtx.effectiveWorkspaceRoot,
        verificationExemptDirs,
        supervisorConfig: supervisorRuntime.supervisorConfig,
        globalPolicy: supervisorRuntime.globalPolicy,
        supervisorBridge: supervisorRuntime.bridge,
        onConfirm: async (toolName, toolArgs) => {
          // 终端确认
          spinner.stop();
          const detail = toolName.includes('(') ? '' : ` (${JSON.stringify(toolArgs).substring(0, 80)})`;
          console.log(`\n${c.yellow}⚠ 需要确认: ${toolName}${detail}${c.reset}`);

          return new Promise<boolean>((resolve) => {
            const confirmRl = createInterface({ input: process.stdin, output: process.stdout });
            confirmRl.question(`${c.yellow}允许执行? (y/n) ${c.reset}`, (answer) => {
              confirmRl.close();
              resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
            });
          });
        },
      };

      const harness = new Harness(harnessConfig, wsCtx.toolExecutor);
      latestHarness = harness;

      spinner.stop();

      const result = await harness.run(
        input,
        (msgs, opts) => ctx.llmAdapter.chat(msgs, opts),
        (event) => {
          if (event.type === 'thinking' && event.content) {
            // 思考内容（部分模型会返回）
          }
          if (event.type === 'tool_progress' && event.content) {
            console.log(`${c.dim}${event.content}${c.reset}`);
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
    // 经由优雅退出执行有序清理（drainMemory → 后台任务 → tunnel → web → mcp），
    // 而非直接 process.exit 跳过 drainMemory 丢失未落盘记忆/状态。
    void triggerShutdown('cli-close');
  });
}
