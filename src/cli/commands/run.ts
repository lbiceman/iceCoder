/**
 * ice run — 单次任务执行（非交互模式）。
 *
 * 用法:
 *   ice run "修复 TypeScript 编译错误"
 *   ice run "给所有函数加 JSDoc" --max-rounds 50
 *   ice run "写一个用户注册 API" --json
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BootstrapResult } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { getFlagNum, hasFlag } from '../utils/args-parser.js';
import { c, info, error, toolCall, toolResult, Spinner } from '../utils/terminal-ui.js';
import { Harness } from '../../harness/harness.js';
import type { HarnessConfig } from '../../harness/types.js';
import { loadMemoryPrompt } from '../../memory/file-memory/index.js';

export async function runRun(ctx: BootstrapResult, args: ParsedArgs): Promise<void> {
  const task = args.positional.join(' ');
  if (!task) {
    error('请提供任务描述。用法: iceCoder run "修复编译错误"');
    process.exit(1);
  }

  const maxRounds = getFlagNum(args.flags, 'max-rounds') ?? 100;
  const jsonOutput = hasFlag(args.flags, 'json');
  const { systemPromptPath, memoryFilesDir } = ctx.paths;

  async function loadSystemPrompt(): Promise<string> {
    try {
      return await fs.readFile(systemPromptPath, 'utf-8');
    } catch {
      return '你是一个智能助手，拥有工具能力。根据用户需求自主决定使用哪些工具。回答使用中文。';
    }
  }

  if (!jsonOutput) {
    info(`任务: ${task}`);
    info(`最大轮次: ${maxRounds}`);
  }

  const spinner = new Spinner('执行中...');
  if (!jsonOutput) spinner.start();

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
        maxRounds,
        timeout: 60 * 60 * 1000,
        tokenBudget: 500000,
      },
      permissions: [],
      compactionThreshold: 40,
      compactionKeepRecent: 10,
      compactionEnableLLMSummary: true,
      memoryDir: memoryFilesDir,
    };

    const harness = new Harness(harnessConfig, ctx.toolExecutor);

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
