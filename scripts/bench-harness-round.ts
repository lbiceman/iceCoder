/**
 * 一轮 Harness 耗时拆分：本地代码 vs 等待模型。
 *
 * 用法:
 *   npx tsx scripts/bench-harness-round.ts
 *   npx tsx scripts/bench-harness-round.ts --live
 *
 * 默认只跑即时 mock（测纯代码路径）。加 --live 再打一枪真实模型。
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { bootstrap } from '../src/cli/bootstrap.js';
import { DEFAULT_SYSTEM_PROMPT, getDefaultWorkDir } from '../src/cli/paths.js';
import { Harness } from '../src/harness/harness.js';
import type { HarnessConfig } from '../src/harness/types.js';
import {
  getHarnessTimingSamples,
  resetHarnessTiming,
  summarizeHarnessTiming,
} from '../src/harness/harness-timing.js';
import {
  getHarnessTimeoutMsFromEnv,
  getHarnessTokenBudget,
} from '../src/harness/token-budget-config.js';
import { loadHarnessSupervisorRuntime } from '../src/harness/supervisor/supervisor-config.js';
import { readSkipPermissionChecksFromMainConfig } from '../src/config/main-config-supervisor-mode.js';
import { readVerificationExemptDirsFromMainConfig } from '../src/harness/verification-exempt-config.js';
import { resolveWorkspaceToolContext } from '../src/harness/workspace-run-context.js';
import { buildMcpRuntimeContext } from '../src/mcp/mcp-runtime-context.js';
import { loadMemoryPrompt } from '../src/memory/file-memory/index.js';
import { harnessOverlayToContextFields } from '../src/prompts/prompt-assembler.js';
import { loadAssembledChatPrompt, shouldDisableRuntimeTools } from '../src/prompts/load-chat-prompt.js';
import {
  selectToolsForOffering,
  getCliDeferredToolCalls,
  buildAvailableDocToolsContext,
  DEFERRED_TOOLS,
} from '../src/tools/tool-offering-selector.js';
import type { ChatFunction, StreamFunction } from '../src/harness/types.js';
import type { LLMResponse } from '../src/llm/types.js';
import type { ToolExecutor } from '../src/tools/tool-executor.js';

const PROMPT = '只用一个数字回答，不要调用任何工具：1+1 等于几？';
const LIVE = process.argv.includes('--live');
const MOCK_ITERS = 3;

function mockResponse(content = '2'): LLMResponse {
  return {
    content,
    usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101, provider: 'mock' },
    finishReason: 'stop',
  };
}

const mockChat: ChatFunction = async () => mockResponse();
const mockStream: StreamFunction = async (_msgs, cb) => {
  cb('2', false);
  cb('', true);
  return mockResponse();
};

async function buildHarnessConfig(
  ctx: Awaited<ReturnType<typeof bootstrap>>,
  sessionDir: string,
  sessionId: string,
  task: string,
): Promise<{
  config: HarnessConfig;
  toolCount: number;
  systemPromptChars: number;
  toolExecutor: ToolExecutor;
}> {
  const assembled = await loadAssembledChatPrompt({
    logPrefix: '[bench]',
    systemPromptPath: ctx.paths.systemPromptPath,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
  const { supervisorConfig, globalPolicy, bridge: supervisorBridge } = await loadHarnessSupervisorRuntime({
    dataDir: ctx.paths.dataDir,
    mainConfigPath: ctx.paths.configPath,
  });
  const skipPermissionChecks = await readSkipPermissionChecksFromMainConfig(ctx.paths.configPath);
  const verificationExemptDirs = await readVerificationExemptDirsFromMainConfig(ctx.paths.configPath);
  const wsCtx = await resolveWorkspaceToolContext({
    sessionDir,
    sessionId,
    userMessage: task,
    defaultWorkDir: getDefaultWorkDir(),
    defaultToolExecutor: ctx.toolExecutor,
    defaultToolRegistry: ctx.toolRegistry,
    fileParser: ctx.fileParser,
    llmAdapter: ctx.llmAdapter,
    mcpManager: ctx.mcpManager,
  });
  let toolDefs = shouldDisableRuntimeTools() ? [] : wsCtx.toolDefs;
  const offeringResult = selectToolsForOffering(toolDefs, {
    userMessage: task,
    uploadedFilePaths: [],
    explicitReferencePaths: [],
    sessionRecentToolCalls: getCliDeferredToolCalls(sessionId),
    shellCollabActive: false,
    hasInlineVisionImages: false,
  });
  toolDefs = offeringResult.tools;
  const docToolsContext = shouldDisableRuntimeTools()
    ? {}
    : buildAvailableDocToolsContext(
      [...offeringResult.activated].filter((n) => DEFERRED_TOOLS.has(n)),
    );
  const mcpRuntimeContext = buildMcpRuntimeContext(
    ctx.mcpManager,
    toolDefs.map((t) => t.name),
  );
  const mergedSystemContext = { ...docToolsContext, ...mcpRuntimeContext };

  const config: HarnessConfig = {
    context: {
      systemPrompt: assembled.systemPrompt,
      tools: toolDefs,
      memoryPrompt: await loadMemoryPrompt({ memoryDir: ctx.paths.memoryFilesDir }) ?? undefined,
      ...harnessOverlayToContextFields(assembled),
      ...(Object.keys(mergedSystemContext).length > 0 ? { systemContext: mergedSystemContext } : {}),
    },
    loop: {
      maxRounds: 8,
      timeout: getHarnessTimeoutMsFromEnv(),
      tokenBudget: getHarnessTokenBudget(),
    },
    permissions: [],
    skipPermissionChecks,
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    compactionEnableLLMSummary: true,
    memoryDir: ctx.paths.memoryFilesDir,
    sessionDir,
    sessionId,
    workspaceRoot: wsCtx.effectiveWorkspaceRoot,
    verificationExemptDirs,
    supervisorConfig,
    globalPolicy,
    supervisorBridge,
  };

  return {
    config,
    toolCount: toolDefs.length,
    systemPromptChars: assembled.systemPrompt.length,
    toolExecutor: wsCtx.toolExecutor,
  };
}

function printSummary(title: string): void {
  const s = summarizeHarnessTiming();
  const byName = new Map<string, number>();
  for (const sample of getHarnessTimingSamples()) {
    byName.set(sample.name, (byName.get(sample.name) ?? 0) + sample.ms);
  }
  console.log(`\n======== ${title} ========`);
  const keys = [
    'run_init',
    'round_prep',
    'prep_compact',
    'prep_memory',
    'prep_build_msgs',
    'graph_stop_check',
    'mode_eval',
    'context_usage',
    'llm_precheck',
    'llm_serialize',
    'llm_first_token',
    'llm_http',
    'llm_wait',
    'llm_deserialize',
    'llm_stream_filter',
    'post_salvage',
    'post_no_tools',
    'post_supervisor',
    'tool_round',
    'round_wall',
    'run_total',
  ];
  for (const key of keys) {
    const ms = byName.get(key);
    if (ms == null) continue;
    console.log(`  ${key.padEnd(20)} ${ms.toFixed(1).padStart(8)} ms`);
  }
  const runCode = Math.max(0, s.runTotalMs - s.waitLlmMs - s.waitToolMs);
  console.log('----------------------------------------');
  console.log(`  一轮墙钟              ${s.roundWallMs.toFixed(1)} ms`);
  console.log(`  本轮代码              ${s.codeMs.toFixed(1)} ms  (${s.codePctOfRound.toFixed(1)}% of round)`);
  console.log(`  等模型 HTTP           ${s.waitLlmMs.toFixed(1)} ms`);
  console.log(`  整次 run 代码         ${runCode.toFixed(1)} ms  (${s.codePctOfRun.toFixed(1)}% of run)`);
}

async function runOnce(
  ctx: Awaited<ReturnType<typeof bootstrap>>,
  sessionDir: string,
  sessionId: string,
  chatFn: ChatFunction,
  streamFn?: StreamFunction,
): Promise<void> {
  resetHarnessTiming();
  const { config, toolCount, systemPromptChars, toolExecutor } = await buildHarnessConfig(
    ctx,
    sessionDir,
    sessionId,
    PROMPT,
  );
  console.log(`[bench] tools=${toolCount} systemPromptChars=${systemPromptChars} session=${sessionId}`);
  const harness = new Harness(config, toolExecutor);
  try {
    const result = await harness.run(PROMPT, chatFn, undefined, undefined, streamFn);
    console.log(`[bench] stop=${result.loopState.stopReason} rounds=${result.loopState.currentRound} tools=${result.loopState.totalToolCalls}`);
  } finally {
    await harness.drainMemory(3_000).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  process.env.ICE_HARNESS_TIMING = '1';
  const ctx = await bootstrap();
  const rootSession = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-bench-round-'));

  try {
    console.log('\n--- mock LLM（即时返回，测纯代码）---');
    for (let i = 0; i < MOCK_ITERS; i++) {
      const sessionDir = path.join(rootSession, `mock-${i}`);
      await fs.mkdir(sessionDir, { recursive: true });
      await runOnce(ctx, sessionDir, `bench-mock-${i}`, mockChat, mockStream);
      printSummary(`mock iter ${i + 1}${i === 0 ? ' (cold)' : ' (warm)'}`);
    }

    if (LIVE) {
      console.log('\n--- live LLM（真实网络）---');
      const sessionDir = path.join(rootSession, 'live');
      await fs.mkdir(sessionDir, { recursive: true });
      await runOnce(
        ctx,
        sessionDir,
        'bench-live',
        (msgs, opts) => ctx.llmAdapter.chat(msgs, opts),
        (msgs, cb, opts) => ctx.llmAdapter.stream(msgs, cb, opts),
      );
      printSummary('live stream (web 路径)');
    } else {
      console.log('\n(跳过真实模型。要测占比请加 --live)');
    }
  } finally {
    await ctx.mcpManager.shutdown().catch(() => undefined);
    await fs.rm(rootSession, { recursive: true, force: true });
  }
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
