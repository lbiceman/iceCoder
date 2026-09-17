import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import type {
  ChatFunction,
  HarnessConfig,
} from '../../src/harness/types.js';
import type {
  LLMResponse,
  ToolDefinition,
} from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolResult } from '../../src/tools/types.js';

const tools = [
  tool('write_file'),
  tool('run_command'),
  tool('read_file'),
];

let roots: string[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true }),
  ));
});

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  };
}

function final(content: string): LLMResponse {
  return {
    content,
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      provider: 'test',
    },
  };
}

function calls(
  entries: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): LLMResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: entries,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      provider: 'test',
    },
  };
}

function chat(responses: LLMResponse[]): ChatFunction {
  const queue = [...responses];
  return vi.fn(async () => queue.shift() ?? final('unexpected extra LLM round'));
}

async function workspace(options: {
  packageTest?: boolean;
} = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-stop-loop-'));
  roots.push(root);
  if (options.packageTest) {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
    }), 'utf8');
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');
  }
  return root;
}

function harness(
  root: string,
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  sessionDir?: string,
  availableTools: ToolDefinition[] = tools,
): Harness {
  const registry = new ToolRegistry();
  for (const definition of availableTools) {
    registry.register({
      definition,
      handler: args => execute(definition.name, args),
    });
  }
  const executor = new ToolExecutor(registry, {
    maxRetries: 0,
    toolTimeout: 5_000,
  });
  const config: HarnessConfig = {
    context: { systemPrompt: 'test', tools: availableTools },
    loop: { maxRounds: 20 },
    workspaceRoot: root,
    sessionDir,
    sessionId: 'stop-loop',
    skipPermissionChecks: true,
    enableRequestAnalysis: false,
    compactionThreshold: 999,
    compactionTokenThreshold: 999_999,
    memoryDir: path.join(root, 'missing-memory'),
  };
  return new Harness(config, executor);
}

function executorFor(
  root: string,
  commandResult: (command: string, invocation: number) => ToolResult,
  commands: string[],
) {
  let invocation = 0;
  return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (name === 'write_file') {
      const target = path.join(root, String(args.path));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(args.content ?? 'changed'), 'utf8');
      return { success: true, output: 'written' };
    }
    if (name === 'run_command') {
      const command = String(args.command ?? '');
      commands.push(command);
      invocation += 1;
      return commandResult(command, invocation);
    }
    return { success: true, output: 'read' };
  };
}

describe('Harness D-prime stop loop', () => {
  it('runs a stale runtime-default plan once and returns the original body without another LLM call', async () => {
    const root = await workspace({ packageTest: true });
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({ success: true, output: 'all green' }),
      commands,
    ));
    const llm = chat([
      calls([{
        id: 'write',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'export const a = 1;' },
      }]),
      final('原始完成正文'),
    ]);

    const result = await run.run('实现功能', llm);

    expect(commands).toEqual(['npm test']);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('原始完成正文');
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.completionStatus).toBe('completed');
    expect(result.completionReason).toBe('verification_passed');
  });

  it('does not rerun explicit commands already completed in an ordinary tool round', async () => {
    const root = await workspace();
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({ success: true, output: 'all green' }),
      commands,
    ));
    const llm = chat([
      calls([
        {
          id: 'write',
          name: 'write_file',
          arguments: { path: 'src/a.ts', content: 'export const a = 1;' },
        },
        {
          id: 'verify',
          name: 'run_command',
          arguments: { command: 'npm test && npm run lint' },
        },
      ]),
      final('两条验收都已通过'),
    ]);

    const result = await run.run(
      '实现功能。完成条件：必须运行 `npm test` 和 `npm run lint`。',
      llm,
    );

    expect(commands).toEqual(['npm test && npm run lint']);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.completionStatus).toBe('completed');
  });

  it('uses one continuation then ends explicit repeated failure as model_done plus failed', async () => {
    const root = await workspace();
    const sessionDir = path.join(root, 'sessions-explicit-failure');
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({
        success: false,
        output: '',
        error: 'Command failed (exit code: 2)',
      }),
      commands,
    ), sessionDir);
    const llm = chat([
      calls([{
        id: 'write',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'broken' },
      }]),
      final('第一次结束提议'),
      final('第二次结束提议'),
    ]);

    const result = await run.run(
      '实现功能。完成条件：必须运行 `npm test`。',
      llm,
    );

    expect(commands).toEqual(['npm test', 'npm test']);
    expect(llm).toHaveBeenCalledTimes(3);
    const continuationMessages = (llm as ReturnType<typeof vi.fn>).mock.calls[2]?.[0];
    expect(continuationMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: '第一次结束提议' }),
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('[System / Stop Verification]'),
      }),
    ]));
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.completionStatus).toBe('failed');
    expect(result.completionReason).toBe('verification_failed');
    expect(result.content).toContain('第二次结束提议');
    expect(result.content).toMatch(/npm test/);
    expect(result.content).toMatch(/exit code 2/i);
    const saved = JSON.parse(await fs.readFile(
      path.join(sessionDir, 'stop-loop.checkpoint.json'),
      'utf8',
    ));
    expect(saved.extensions.legacyApi.status).toBe('failed');
    expect(saved.execution.lastStopReason).toBe('model_done');
  });

  it('uses one continuation then degrades repeated runtime-default failure to unverified', async () => {
    const root = await workspace({ packageTest: true });
    const sessionDir = path.join(root, 'sessions-default-failure');
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({
        success: false,
        output: '',
        error: 'Command failed (exit code: 1)',
      }),
      commands,
    ), sessionDir);
    const llm = chat([
      calls([{
        id: 'write',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'broken' },
      }]),
      final('第一次结束提议'),
      final('第二次结束提议'),
    ]);

    const result = await run.run('实现功能', llm);

    expect(commands).toEqual(['npm test', 'npm test']);
    expect(llm).toHaveBeenCalledTimes(3);
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.completionStatus).toBe('completed_unverified');
    expect(result.content).toMatch(/npm test/);
    expect(result.content).toMatch(/exit code 1/i);
    const saved = JSON.parse(await fs.readFile(
      path.join(sessionDir, 'stop-loop.checkpoint.json'),
      'utf8',
    ));
    expect(saved.extensions.legacyApi.status).toBe('completed');
    expect(saved.completion.status).toBe('completed_unverified');
  });

  it('pauses an invalid explicit plan and never invokes run_command', async () => {
    const root = await workspace({ packageTest: true });
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({ success: true, output: 'unexpected' }),
      commands,
    ));
    const llm = chat([
      calls([{
        id: 'write',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'changed' },
      }]),
      final('完成'),
    ]);

    const result = await run.run('实现功能。完成条件：必须运行 ``。', llm);

    expect(commands).toEqual([]);
    expect(result.completionStatus).toBe('paused');
    expect(result.completionReason).toBe('verification_plan_invalid');
  });

  it('marks engineering changes unverified when no plan is available', async () => {
    const root = await workspace();
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({ success: true, output: 'unexpected' }),
      commands,
    ));
    const llm = chat([
      calls([{
        id: 'write',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'changed' },
      }]),
      final('完成但没有可靠测试入口'),
    ]);

    const result = await run.run('实现功能', llm);

    expect(commands).toEqual([]);
    expect(result.completionStatus).toBe('completed_unverified');
    expect(result.completionReason).toBe('verification_plan_unavailable');
  });

  it('does not run a runtime default for a test-only task without file mutations', async () => {
    const root = await workspace({ packageTest: true });
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({ success: true, output: 'unexpected' }),
      commands,
    ));
    const llm = chat([final('测试总结')]);

    const result = await run.run('运行测试', llm);

    expect(commands).toEqual([]);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('测试总结');
    expect(result.completionStatus).toBe('completed');
  });

  it('runs an explicit user plan even when the marker-only goal infers no edit intent', async () => {
    const root = await workspace();
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({ success: true, output: 'all green' }),
      commands,
    ));
    const llm = chat([final('验收总结')]);

    const result = await run.run('完成条件：必须运行 `npm test`。', llm);

    expect(commands).toEqual(['npm test']);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.completionStatus).toBe('completed');
    expect(result.completionReason).toBe('verification_passed');
  });

  it('does not run verification for a question even when a runtime default exists', async () => {
    const root = await workspace({ packageTest: true });
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      () => ({ success: true, output: 'unexpected' }),
      commands,
    ));

    const result = await run.run('为什么这里会失败？', chat([final('因为输入无效。')]));

    expect(commands).toEqual([]);
    expect(result.completionStatus).toBe('completed');
    expect(result.completionReason).toBe('verification_not_required');
  });

  it('keeps the one-shot continuation consumed while allowing a repaired mutation to pass', async () => {
    const root = await workspace({ packageTest: true });
    const sessionDir = path.join(root, 'sessions-repair');
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      (_command, invocation) => invocation === 1
        ? {
            success: false,
            output: '',
            error: 'Command failed (exit code: 1)',
          }
        : { success: true, output: 'all green' },
      commands,
    ), sessionDir);
    const llm = chat([
      calls([{
        id: 'write-initial',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'broken' },
      }]),
      final('第一次结束提议'),
      calls([{
        id: 'write-fix',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'fixed' },
      }]),
      final('修复后的结束提议'),
    ]);

    const result = await run.run('实现功能', llm);

    expect(commands).toEqual(['npm test', 'npm test']);
    expect(result.completionStatus).toBe('completed');
    const saved = JSON.parse(await fs.readFile(
      path.join(sessionDir, 'stop-loop.checkpoint.json'),
      'utf8',
    ));
    expect(saved.completion.verificationState.continuationCount).toBe(1);
    expect(saved.completion.verificationState.verifiedMutationVersion).toBe(2);
  });

  it('maps a verification command that mutates the workspace to paused for an explicit plan', async () => {
    const root = await workspace();
    const commands: string[] = [];
    const execute = executorFor(
      root,
      () => ({ success: true, output: 'command passed but changed files' }),
      commands,
    );
    const run = harness(root, async (name, args) => {
      if (name === 'run_command') {
        await fs.writeFile(path.join(root, 'src/generated.ts'), 'generated', 'utf8');
      }
      return execute(name, args);
    });

    const result = await run.run(
      '实现功能。完成条件：必须运行 `npm test`。',
      chat([
        calls([{
          id: 'write',
          name: 'write_file',
          arguments: { path: 'src/a.ts', content: 'changed' },
        }]),
        final('完成'),
      ]),
    );

    expect(commands).toEqual(['npm test']);
    expect(result.loopState.stopReason).toBe('completion_paused');
    expect(result.completionStatus).toBe('paused');
    expect(result.completionReason).toBe('verification_unavailable');
  });

  it('does not treat a mutating ordinary plan command as fresh', async () => {
    const root = await workspace();
    const sessionDir = path.join(root, 'sessions-mutating-ordinary');
    const commands: string[] = [];
    let verificationInvocation = 0;
    const execute = executorFor(
      root,
      () => ({ success: true, output: 'command passed but changed files' }),
      commands,
    );
    const run = harness(root, async (name, args) => {
      if (name === 'run_command') {
        verificationInvocation += 1;
        await fs.writeFile(
          path.join(root, 'src/generated.ts'),
          `generated-${verificationInvocation}`,
          'utf8',
        );
      }
      return execute(name, args);
    }, sessionDir);

    const result = await run.run(
      '实现功能。完成条件：必须运行 `npm test`。',
      chat([
        calls([{
          id: 'write',
          name: 'write_file',
          arguments: { path: 'src/a.ts', content: 'changed' },
        }]),
        calls([{
          id: 'ordinary-verify',
          name: 'run_command',
          arguments: { command: 'npm test' },
        }]),
        final('完成'),
      ]),
    );

    expect(commands).toEqual(['npm test', 'npm test']);
    expect(result.completionStatus).toBe('paused');
    expect(result.completionReason).toBe('verification_unavailable');
    const saved = JSON.parse(await fs.readFile(
      path.join(sessionDir, 'stop-loop.checkpoint.json'),
      'utf8',
    ));
    expect(saved.completion.verificationState.commandProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'npm test',
          status: 'passed',
          mutationVersion: 1,
          evidenceRef: 'ordinary-verify',
        }),
      ]),
    );
  });

  it.each([
    {
      label: 'user',
      goal: '实现功能。完成条件：必须运行 `npm test`。',
      workspaceOptions: {},
      expectedStatus: 'paused',
      expectedStopReason: 'completion_paused',
    },
    {
      label: 'runtime-default',
      goal: '实现功能',
      workspaceOptions: { packageTest: true },
      expectedStatus: 'completed_unverified',
      expectedStopReason: 'model_done',
    },
  ] as const)(
    'maps unavailable $label verification without pretending it completed',
    async ({ goal, workspaceOptions, expectedStatus, expectedStopReason }) => {
      const root = await workspace(workspaceOptions);
      const commands: string[] = [];
      const availableTools = tools.filter(definition => definition.name !== 'run_command');
      const run = harness(
        root,
        executorFor(
          root,
          () => ({ success: true, output: 'unexpected' }),
          commands,
        ),
        undefined,
        availableTools,
      );

      const result = await run.run(goal, chat([
        calls([{
          id: 'write',
          name: 'write_file',
          arguments: { path: 'src/a.ts', content: 'changed' },
        }]),
        final('完成'),
      ]));

      expect(commands).toEqual([]);
      expect(result.completionStatus).toBe(expectedStatus);
      expect(result.loopState.stopReason).toBe(expectedStopReason);
      expect(result.completionReason).toBe('verification_unavailable');
    },
  );

  it('fusion-06: ignores unrelated git diff failure after successful explicit verification', async () => {
    const root = await workspace();
    const commands: string[] = [];
    const run = harness(root, executorFor(
      root,
      command => command.startsWith('git diff')
        ? {
            success: false,
            output: '',
            error: 'Command failed (exit code: 129)',
          }
        : { success: true, output: 'all green' },
      commands,
    ));
    const llm = chat([
      ...Array.from({ length: 15 }, (_, index) => calls([{
        id: `read-${index + 1}`,
        name: 'read_file',
        arguments: { path: `src/context-${index + 1}.ts` },
      }])),
      calls([
        {
          id: 'write',
          name: 'write_file',
          arguments: { path: 'src/a.ts', content: 'fixed' },
        },
        {
          id: 'verify',
          name: 'run_command',
          arguments: { command: 'npm test' },
        },
      ]),
      calls([{
        id: 'install',
        name: 'run_command',
        arguments: { command: 'npm ci' },
      }]),
      calls([{
        id: 'diff',
        name: 'run_command',
        arguments: { command: 'git diff --name-only -- test/' },
      }]),
      final('第 19 轮最终正文'),
    ]);

    const result = await run.run(
      '完成条件：必须运行 `npm test`。',
      llm,
    );

    expect(commands).toEqual([
      'npm test',
      'npm ci',
      'git diff --name-only -- test/',
    ]);
    expect(llm).toHaveBeenCalledTimes(19);
    expect(result.loopState.currentRound).toBe(19);
    expect(result.content).toBe('第 19 轮最终正文');
    expect(result.completionStatus).toBe('completed');
  });

  it('restores fresh verification from V3 and invalidates it when the current plan changes', async () => {
    const root = await workspace({ packageTest: true });
    const sessionDir = path.join(root, 'sessions');
    const commands: string[] = [];
    const execute = executorFor(
      root,
      () => ({ success: true, output: 'all green' }),
      commands,
    );
    const first = harness(root, execute, sessionDir);
    await first.run('实现功能。', chat([
      calls([{
        id: 'write',
        name: 'write_file',
        arguments: { path: 'src/a.ts', content: 'changed' },
      }]),
      final('首次完成'),
    ]));

    const checkpointPath = path.join(sessionDir, 'stop-loop.checkpoint.json');
    const saved = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    expect(saved.completion.verificationPlan).toMatchObject({
      source: 'runtime_default',
      commands: [{ command: 'npm test', required: true }],
    });
    expect(saved.completion.verificationState).toMatchObject({
      workspaceMutationVersion: 1,
      verifiedMutationVersion: 1,
      verifiedPlanFingerprint: saved.completion.verificationPlan.fingerprint,
    });

    const resumed = harness(root, execute, sessionDir);
    const resumeLlm = chat([final('恢复后直接完成')]);
    const freshResult = await resumed.run('实现功能。', resumeLlm);
    expect(freshResult.completionStatus).toBe('completed');
    expect(commands).toEqual(['npm test']);
    expect(resumeLlm).toHaveBeenCalledTimes(1);

    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '', 'utf8');
    const changedPlan = harness(root, execute, sessionDir);
    const changedResult = await changedPlan.run(
      '实现功能。',
      chat([final('新计划完成')]),
    );

    expect(changedResult.completionStatus).toBe('completed');
    expect(commands).toEqual(['npm test', 'pnpm test']);
  });
});
