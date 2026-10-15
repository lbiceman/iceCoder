/**
 * Harness 审计 P4 的端到端 eval（脚本驱动 LLM，不打真实 API）。
 * #88：计时、遥测、命令清单、验收豁免按会话分开，作用域外的 set 不写进程配置。
 * #86：一次 run 仍能走完，说明各阶段依赖视图接在同一份字段上。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import {
  getHarnessTimingSamples,
  recordHarnessTiming,
  resetHarnessTiming,
  runWithHarnessTimingScope,
} from '../../src/harness/harness-timing.js';
import { RuntimeTelemetry, runtimeTelemetryFile } from '../../src/harness/runtime-telemetry.js';
import {
  isProjectCustomExemptPath,
  runWithVerificationExemptScope,
  setVerificationExemptRuntime,
} from '../../src/harness/verification-exempt-config.js';
import {
  listWorkspaceFileInventory,
  rememberPreCommandInventory,
  runWithWorkspaceTouchScope,
  takePreCommandInventory,
  type WorkspaceFileInventory,
} from '../../src/harness/workspace-command-touch.js';
import type { HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolHandler } from '../../src/tools/types.js';

function makeTool(name: string): ToolDefinition {
  return { name, description: `eval ${name}`, parameters: { type: 'object', properties: {} } };
}

function finalResponse(content: string): LLMResponse {
  return {
    content,
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, provider: 'eval' },
    finishReason: 'stop',
  };
}

function createToolExecutor(handlers: Record<string, ToolHandler>): { executor: ToolExecutor; tools: ToolDefinition[] } {
  const registry = new ToolRegistry();
  const tools = Object.keys(handlers).map(makeTool);
  for (const t of tools) registry.register({ definition: t, handler: handlers[t.name]! });
  return {
    tools,
    executor: new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5_000 }),
  };
}

function minConfig(overrides: Partial<HarnessConfig> & { tools: ToolDefinition[] }): HarnessConfig {
  const { tools, context, loop, ...rest } = overrides;
  return {
    context: { systemPrompt: 'eval harness', tools, ...context },
    loop: { maxRounds: loop?.maxRounds ?? 4, timeout: loop?.timeout, signal: loop?.signal },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999_999,
    memoryDir: '__test_nonexistent_memory_dir__',
    skipPermissionChecks: true,
    ...rest,
  };
}

function stubMemoryPersist(harness: Harness): void {
  const mem = (harness as unknown as {
    memoryIntegration: {
      sequentialExtract: () => Promise<void>;
      maybeUpdateSessionMemory: () => Promise<void>;
      maybeDream: () => Promise<void>;
      memoryDream: { recordSession: () => Promise<void> };
    };
  }).memoryIntegration;
  vi.spyOn(mem, 'sequentialExtract').mockResolvedValue(undefined);
  vi.spyOn(mem, 'maybeUpdateSessionMemory').mockResolvedValue(undefined);
  vi.spyOn(mem, 'maybeDream').mockResolvedValue(undefined);
  vi.spyOn(mem.memoryDream, 'recordSession').mockResolvedValue(undefined);
}

function blankInventory(): WorkspaceFileInventory {
  const inventory = new Map() as WorkspaceFileInventory;
  inventory.complete = true;
  inventory.contentReads = 0;
  return inventory;
}

describe('eval: harness audit P4 #86 #88', () => {
  const previousTiming = process.env.ICE_HARNESS_TIMING;

  afterEach(() => {
    if (previousTiming === undefined) delete process.env.ICE_HARNESS_TIMING;
    else process.env.ICE_HARNESS_TIMING = previousTiming;
    vi.restoreAllMocks();
  });

  it('keeps timing samples inside the run that recorded them', async () => {
    process.env.ICE_HARNESS_TIMING = '1';
    const names = await Promise.all([
      runWithHarnessTimingScope(async () => {
        resetHarnessTiming();
        recordHarnessTiming('alpha', 1);
        await new Promise(resolve => setTimeout(resolve, 15));
        return getHarnessTimingSamples().map(sample => sample.name);
      }),
      runWithHarnessTimingScope(async () => {
        resetHarnessTiming();
        recordHarnessTiming('beta', 2);
        await new Promise(resolve => setTimeout(resolve, 15));
        return getHarnessTimingSamples().map(sample => sample.name);
      }),
    ]);
    expect(names[0]).toEqual(['alpha']);
    expect(names[1]).toEqual(['beta']);
  });

  it('writes each session telemetry to its own file', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-p4c-tel-'));
    try {
      const alpha = new RuntimeTelemetry(dir, 'alpha');
      const beta = new RuntimeTelemetry(dir, 'beta');
      await alpha.recordFailure({ source: 'checkpoint_save', message: 'alpha-down' });
      await beta.recordFailure({ source: 'checkpoint_save', message: 'beta-down' });
      const alphaText = await fs.readFile(runtimeTelemetryFile(dir, 'alpha'), 'utf8');
      const betaText = await fs.readFile(runtimeTelemetryFile(dir, 'beta'), 'utf8');
      expect(alphaText).toContain('alpha-down');
      expect(alphaText).not.toContain('beta-down');
      expect(betaText).toContain('beta-down');
      expect(betaText).not.toContain('alpha-down');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not keep a command inventory or file hash across sessions', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-p4c-touch-'));
    await fs.writeFile(path.join(root, 'a.txt'), 'body', 'utf8');
    try {
      const firstReads = await runWithWorkspaceTouchScope(async () => {
        rememberPreCommandInventory('s', 'call-1', blankInventory());
        const listed = await listWorkspaceFileInventory(root);
        return listed.contentReads;
      });
      expect(firstReads).toBeGreaterThan(0);

      const second = await runWithWorkspaceTouchScope(async () => {
        const kept = takePreCommandInventory('s', 'call-1');
        const listed = await listWorkspaceFileInventory(root);
        return { kept, reads: listed.contentReads };
      });
      expect(second.kept).toBeUndefined();
      expect(second.reads).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('ignores verification-exempt updates outside a run scope', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setVerificationExemptRuntime({ workspaceRoot: 'E:/proj/g', prefixes: ['.scratch-g'] });
    expect(isProjectCustomExemptPath('E:/proj/g/.scratch-g/x.md')).toBe(false);
    expect(warn).toHaveBeenCalled();

    runWithVerificationExemptScope(() => {
      setVerificationExemptRuntime({ workspaceRoot: 'E:/proj/g', prefixes: ['.scratch-g'] });
      expect(isProjectCustomExemptPath('E:/proj/g/.scratch-g/x.md')).toBe(true);
    });
  });

  it('still finishes a run when each phase sees only its own dependency view', async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-p4c-run-'));
    try {
      const { executor, tools } = createToolExecutor({
        read_file: async () => ({ success: true, output: 'ok' }),
      });
      const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
      stubMemoryPersist(harness);
      const result = await harness.run('读一下说明', async () => finalResponse('看完了。'));
      expect(result.loopState.stopReason).toBe('model_done');
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});
