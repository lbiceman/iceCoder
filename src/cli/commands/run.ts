/**
 * ice run — 单次任务执行（非交互模式）。
 *
 * 用法:
 *   ice run "修复 TypeScript 编译错误"
 *   ice run "给所有函数加 JSDoc" --max-rounds 50
 *   ice run "写一个用户注册 API" --json
 */

import type { BootstrapResult } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { getFlagNum, hasFlag } from '../utils/args-parser.js';
import { c, info, error, toolCall, toolResult, Spinner } from '../utils/terminal-ui.js';
import { Harness } from '../../harness/harness.js';
import type { HarnessConfig } from '../../harness/types.js';
import { loadMemoryPrompt } from '../../memory/file-memory/index.js';
import { harnessOverlayToContextFields } from '../../prompts/prompt-assembler.js';
import { loadAssembledChatPrompt, shouldDisableRuntimeTools } from '../../prompts/load-chat-prompt.js';
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
import { resolveWorkspaceToolContext } from '../../harness/workspace-run-context.js';
import { buildMcpRuntimeContext } from '../../mcp/mcp-runtime-context.js';

export async function runRun(ctx: BootstrapResult, args: ParsedArgs): Promise<void> {
  const task = args.positional.join(' ');
  if (!task) {
    error('请提供任务描述。用法: iceCoder run "修复编译错误"');
    process.exit(1);
  }

  const maxRounds = getFlagNum(args.flags, 'max-rounds') ?? getHarnessMaxRoundsFromEnv();
  const jsonOutput = hasFlag(args.flags, 'json');
  const { memoryFilesDir } = ctx.paths;

  if (!jsonOutput) {
    info(`任务: ${task}`);
    info(`最大轮次: ${maxRounds}`);
  }

  const spinner = new Spinner('执行中...');
  if (!jsonOutput) spinner.start();

  try {
    const assembled = await loadAssembledChatPrompt({
      logPrefix: '[run]',
      systemPromptPath: ctx.paths.systemPromptPath,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    let toolDefs = shouldDisableRuntimeTools() ? [] : ctx.toolRegistry.getDefinitions();
    const { supervisorConfig, globalPolicy, bridge: supervisorBridge } = await loadHarnessSupervisorRuntime({
      dataDir: ctx.paths.dataDir,
      mainConfigPath: ctx.paths.configPath,
    });

    const skipPermissionChecks = await readSkipPermissionChecksFromMainConfig(ctx.paths.configPath);
    const verificationExemptDirs = await readVerificationExemptDirsFromMainConfig(ctx.paths.configPath);

    const wsCtx = await resolveWorkspaceToolContext({
      sessionDir: ctx.paths.sessionsDir,
      sessionId: 'default',
      userMessage: task,
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
        maxRounds,
        timeout: getHarnessTimeoutMsFromEnv(),
        tokenBudget: getHarnessTokenBudget(),
      },
      permissions: [],
      skipPermissionChecks,
      compactionThreshold: 40,
      compactionKeepRecent: 10,
      compactionEnableLLMSummary: true,
      memoryDir: memoryFilesDir,
      sessionDir: ctx.paths.sessionsDir,
      sessionId: 'default',
      workspaceRoot: wsCtx.effectiveWorkspaceRoot,
      verificationExemptDirs,
      supervisorConfig,
      globalPolicy,
      supervisorBridge,
    };

    const harness = new Harness(harnessConfig, wsCtx.toolExecutor);

    if (!jsonOutput) spinner.stop();

    const result = await harness.run(
      task,
      (msgs, opts) => ctx.llmAdapter.chat(msgs, opts),
      (event) => {
        if (jsonOutput) return;
        if (event.type === 'tool_call' && event.toolName) {
          toolCall(event.toolName, event.toolArgs ? JSON.stringify(event.toolArgs) : '');
        }
        if (event.type === 'tool_result') {
          toolResult(event.toolSuccess ?? false);
        }
      },
    );

    if (jsonOutput) {
      // JSON 输出模式
      const output = {
        success: true,
        content: result.content,
        toolCalls: result.loopState.totalToolCalls,
        rounds: result.loopState.currentRound,
        tokens: {
          input: result.loopState.totalInputTokens,
          output: result.loopState.totalOutputTokens,
        },
        stopReason: result.loopState.stopReason,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      // 人类可读输出
      if (result.content) {
        console.log('\n' + result.content);
      }
      console.log('');
      const state = result.loopState;
      console.log(`${c.dim}[${state.totalToolCalls} 次工具调用 | ${state.currentRound} 轮 | ↑${state.totalInputTokens} ↓${state.totalOutputTokens} tokens]${c.reset}`);
    }

    process.exit(0);
  } catch (err) {
    spinner.stop();
    if (jsonOutput) {
      console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      error('执行失败: ' + (err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
  }
}
