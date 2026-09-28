import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Harness } from '../../../src/harness/harness.js';
import { StopHookManager } from '../../../src/harness/stop-hooks.js';
import type {
  ChatFunction,
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
} from '../../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../../src/llm/types.js';
import { ToolExecutor } from '../../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../../src/tools/tool-registry.js';
import type { ToolResult } from '../../../src/tools/types.js';
import {
  AgentSpawner,
  type AgentHarnessFactory,
  type HarnessLike,
} from '../../../src/harness/agents/agent-spawner.js';
import { WriteLeaseRegistry } from '../../../src/harness/agents/write-lease.js';
import { deleteAgentRecordsForMessages, loadAgentMeta, loadAgentMessages } from '../../../src/harness/agents/agent-store.js';
import { hasFileBeenRead, markFileRead } from '../../../src/tools/read-before-edit.js';

// ─── helpers ───

function tool(name: string): ToolDefinition {
  return { name, description: name, parameters: { type: 'object', properties: {} } };
}

function usage(input = 100, output = 50) {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, provider: 'test' };
}

function final(content: string): LLMResponse {
  return { content, usage: usage(), finishReason: 'stop' };
}

function calls(list: Array<{ id: string; name: string; args?: Record<string, unknown> }>): LLMResponse {
  return {
    content: '',
    toolCalls: list.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: usage(),
    finishReason: 'tool_calls',
  };
}

const REPORT = '1. **Conclusion** — done.\n2. **Changes** — none.\n3. **Verification** — none.\n4. **Open issues / risks** — none.';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeWorkspaceExecutor(root: string, commandOutput?: (args: Record<string, any>) => ToolResult): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register({
    definition: tool('read_file'),
    handler: async (args) => {
      try {
        return { success: true, output: await fs.readFile(path.resolve(root, String(args.path)), 'utf-8') };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
  });
  registry.register({
    definition: tool('write_file'),
    handler: async (args) => {
      const abs = path.resolve(root, String(args.path));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(args.content ?? ''), 'utf-8');
      return { success: true, output: `wrote ${args.path}` };
    },
  });
  registry.register({
    definition: tool('run_command'),
    handler: async (args) => commandOutput?.(args)
      ?? { success: true, output: JSON.stringify({ exitCode: 0, stdout: 'ok' }) },
  });
  registry.register({ definition: tool('git'), handler: async () => ({ success: true, output: 'clean' }) });
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

function parentConfig(root: string, sessionsDir: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    context: {
      systemPrompt: 'parent',
      tools: [tool('read_file'), tool('write_file'), tool('run_command'), tool('git'), tool('memory_write'), tool('request_analysis')],
    },
    loop: { maxRounds: 50, timeout: 10 * 60 * 1000 },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999_999,
    memoryDir: '__test_nonexistent_memory_dir__',
    sessionDir: sessionsDir,
    sessionId: 'parent-session',
    workspaceRoot: root,
    workspaceLock: { lockedRoot: root, referenceReads: [] },
    ...overrides,
  };
}

/** 子 Agent 的脚本按 prompt 分派；每个子 Agent 各自的响应队列。 */
function scriptedChildLlm(scripts: Record<string, Array<LLMResponse | (() => Promise<LLMResponse>)>>) {
  const seenTools: Record<string, string[]> = {};
  const queues = new Map<string, Array<LLMResponse | (() => Promise<LLMResponse>)>>();
  const createLlm = () => {
    let key: string | undefined;
    const chat: ChatFunction = async (msgs, opts) => {
      if (!key) {
        const firstUser = msgs.find(m => m.role === 'user');
        const text = typeof firstUser?.content === 'string' ? firstUser.content : '';
        key = Object.keys(scripts).find(k => text.includes(k)) ?? '__none__';
        queues.set(key, [...(scripts[key] ?? [])]);
        seenTools[key] = opts.tools.map(t => t.name);
      }
      const next = queues.get(key)!.shift();
      if (!next) return final(REPORT);
      return typeof next === 'function' ? next() : next;
    };
    return { chat };
  };
  return { createLlm, seenTools };
}

function realHarnessFactory(): AgentHarnessFactory {
  return (config, executor) => new Harness(config, executor);
}

function taskCall(id: string, prompt: string, extra: Record<string, unknown> = {}) {
  return { id, name: 'task', args: { description: prompt.slice(0, 20), prompt, ...extra } };
}

function toolMessage(messages: UnifiedMessage[], toolCallId: string): string {
  const msg = messages.find(m => m.role === 'tool' && m.toolCallId === toolCallId);
  return typeof msg?.content === 'string' ? msg.content : '';
}

let tmp: string;
let root: string;
let sessionsDir: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-agents-'));
  root = path.join(tmp, 'ws');
  sessionsDir = path.join(tmp, 'sessions');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

// ─── 启用范围 ───

describe('task 工具暴露', () => {
  it('有 agentSpawner 时主 Agent 工具列表包含 task；否则去掉 task', async () => {
    const spawner = new AgentSpawner({
      parentSessionId: 'p',
      sessionsDir,
      messageId: 'm1',
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: realHarnessFactory(),
      persist: false,
    });
    const seen: string[][] = [];
    const chat: ChatFunction = async (_m, opts) => {
      seen.push(opts.tools.map(t => t.name));
      return final('done');
    };
    const executor = makeWorkspaceExecutor(root);
    const withSpawner = parentConfig(root, sessionsDir, { agentSpawner: spawner });
    withSpawner.context.tools = withSpawner.context.tools.filter(t => t.name !== 'request_analysis');
    await new Harness(withSpawner, executor).run('hi', chat);
    expect(seen[0]).toContain('task');
    expect(seen[0]).not.toContain('request_analysis');

    const cfg = parentConfig(root, sessionsDir);
    cfg.context.tools = [...cfg.context.tools, tool('task')];
    seen.length = 0;
    await new Harness(cfg, executor).run('hi', chat);
    expect(seen[0]).not.toContain('task');
  });
});

// ─── 运行（真实子 Harness） ───

describe('AgentSpawner 与真实子 Harness', () => {
  it('子 Agent 工具列表去掉 task / 记忆 / request_analysis；explore 只读', async () => {
    const { createLlm, seenTools } = scriptedChildLlm({ 'GEN-TASK': [final(REPORT)], 'EXP-TASK': [final(REPORT)] });
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm1', createLlm,
      harnessFactory: realHarnessFactory(), leaseRegistry: new WriteLeaseRegistry(), persist: false,
    });
    const parentChat = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(calls([
        taskCall('t1', 'GEN-TASK'),
        taskCall('t2', 'EXP-TASK', { subagent_type: 'explore' }),
      ]))
      .mockResolvedValue(final('all done'));
    await new Harness(parentConfig(root, sessionsDir, { agentSpawner: spawner }), makeWorkspaceExecutor(root))
      .run('do it', parentChat);

    expect(seenTools['GEN-TASK']).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command']));
    for (const name of ['task', 'memory_write', 'request_analysis']) {
      expect(seenTools['GEN-TASK']).not.toContain(name);
      expect(seenTools['EXP-TASK']).not.toContain(name);
    }
    expect(seenTools['EXP-TASK']).toContain('read_file');
    expect(seenTools['EXP-TASK']).not.toContain('write_file');
    expect(seenTools['EXP-TASK']).not.toContain('run_command');
  });

  it('同一回复里的 3 个 task 并行运行；主消息只含 task 调用与结果；结果来自工具记录', async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (resp: LLMResponse) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(60);
      active--;
      return resp;
    };
    const { createLlm } = scriptedChildLlm({
      'TASK-A': [slow(calls([{ id: 'w', name: 'write_file', args: { path: 'a.ts', content: 'a\nb\n' } }])),
        final('I changed nothing at all.')],
      'TASK-B': [slow(final(REPORT))],
      'TASK-C': [slow(final(REPORT))],
    });
    const events: HarnessStepEvent[] = [];
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm1', createLlm,
      harnessFactory: realHarnessFactory(), leaseRegistry: new WriteLeaseRegistry(), updateThrottleMs: 0,
    });
    const parentChat = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(calls([taskCall('t1', 'TASK-A'), taskCall('t2', 'TASK-B'), taskCall('t3', 'TASK-C')]))
      .mockResolvedValue(final('all done'));
    const result = await new Harness(
      parentConfig(root, sessionsDir, { agentSpawner: spawner }),
      makeWorkspaceExecutor(root),
    ).run('do it', parentChat, e => events.push(e));

    expect(maxActive).toBe(3);
    const a = toolMessage(result.messages, 't1');
    expect(a).toContain('[Agent Result] agent=general');
    expect(a).toContain('files changed (1): a.ts (+2 -0) [new]');
    expect(a).toContain('I changed nothing at all.');
    expect(toolMessage(result.messages, 't2')).toContain('status=completed');

    // 主会话结构化消息里没有子 Agent 的对话
    const texts = result.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    expect(texts).not.toContain('TASK-A\n');
    expect(result.messages.some(m => m.toolCallId === 'w')).toBe(false);

    // 转发事件带 agentId，toolCallId 带前缀
    const forwarded = events.filter(e => e.agentId && e.type === 'tool_call');
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[0]!.toolCallId).toBe(`${forwarded[0]!.agentId}:w`);
    expect(forwarded[0]!.parentToolCallId).toBe('t1');
    const updates = events.filter(e => e.type === 'agent_update');
    expect(updates.some(e => e.agent?.status === 'running')).toBe(true);
    expect(updates.some(e => e.agent?.status === 'completed')).toBe(true);

    // agents 目录：meta + 结构化消息
    const agentId = forwarded[0]!.agentId!;
    const meta = await loadAgentMeta(sessionsDir, 'parent-session', agentId);
    expect(meta?.status).toBe('completed');
    expect(meta?.messageId).toBe('m1');
    expect(meta?.fileChangeDetails?.[0]?.path).toBe('a.ts');
    const childMessages = await loadAgentMessages(sessionsDir, 'parent-session', agentId);
    expect(childMessages?.some(m => m.toolCallId === 'w')).toBe(true);
  });

  it('子 Agent 跑 50 轮以上并经过压缩后仍能完成；父会话已读记录不被清空', async () => {
    await fs.writeFile(path.join(root, 'big.ts'), 'x'.repeat(2000), 'utf-8');
    markFileRead(root, 'parent-read.ts', 'parent-session');
    const steps: Array<LLMResponse> = Array.from({ length: 55 }, (_, i) =>
      calls([{ id: `r${i}`, name: 'read_file', args: { path: 'big.ts', offset: i } }]));
    const { createLlm } = scriptedChildLlm({ 'LONG-TASK': [...steps, final(REPORT)] });
    const events: HarnessStepEvent[] = [];
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm1', createLlm,
      harnessFactory: realHarnessFactory(), leaseRegistry: new WriteLeaseRegistry(), persist: false,
    });
    const result = await spawner.runTask(
      { id: 't', name: 'task', arguments: { description: 'long', prompt: 'LONG-TASK' } },
      {
        config: parentConfig(root, sessionsDir, {
          compactionThreshold: 20,
          compactionTokenThreshold: 3000,
          compactionKeepRecent: 6,
        }),
        toolExecutor: makeWorkspaceExecutor(root),
        workspaceRoot: root,
        onStep: e => events.push(e),
      },
    );
    expect(result.output).toContain('status=completed');
    expect(Number(/rounds=(\d+)/.exec(result.output)?.[1])).toBeGreaterThan(50);
    expect(events.some(e => e.agentId && e.type === 'compaction')).toBe(true);
    expect(hasFileBeenRead(root, 'parent-read.ts', 'parent-session')).toBe(true);
  });

  it('两个并行子 Agent 写同一文件：后写者被租约拒绝', async () => {
    const { createLlm } = scriptedChildLlm({
      'FIRST': [
        calls([{ id: 'w1', name: 'write_file', args: { path: 'shared.ts', content: 'one' } }]),
        async () => { await sleep(150); return final(REPORT); },
      ],
      'SECOND': [
        async () => {
          await sleep(60);
          return calls([{ id: 'w2', name: 'write_file', args: { path: 'shared.ts', content: 'two' } }]);
        },
        final(REPORT),
      ],
    });
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm1', createLlm,
      harnessFactory: realHarnessFactory(), leaseRegistry: new WriteLeaseRegistry(), persist: false,
    });
    const parentChat = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(calls([taskCall('t1', 'FIRST'), taskCall('t2', 'SECOND')]))
      .mockResolvedValue(final('done'));
    const result = await new Harness(
      parentConfig(root, sessionsDir, { agentSpawner: spawner }),
      makeWorkspaceExecutor(root),
    ).run('go', parentChat);

    expect(await fs.readFile(path.join(root, 'shared.ts'), 'utf-8')).toBe('one');
    const second = toolMessage(result.messages, 't2');
    expect(second).toContain('write lease rejects (1): shared.ts');
    expect(second).toContain('files changed (0)');
  });

  it('子 Agent 执行 git commit 被拒绝，git status 允许', async () => {
    const { createLlm } = scriptedChildLlm({
      'GIT-TASK': [
        calls([
          { id: 'g1', name: 'git', args: { subcommand: 'commit', args: ['-m', 'x'] } },
          { id: 'g2', name: 'run_command', args: { command: 'git checkout main' } },
          { id: 'g3', name: 'git', args: { subcommand: 'status' } },
        ]),
        final(REPORT),
      ],
    });
    const events: HarnessStepEvent[] = [];
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm1', createLlm,
      harnessFactory: realHarnessFactory(), leaseRegistry: new WriteLeaseRegistry(), persist: false,
    });
    const parentChat = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(calls([taskCall('t1', 'GIT-TASK')]))
      .mockResolvedValue(final('done'));
    await new Harness(parentConfig(root, sessionsDir, { agentSpawner: spawner }), makeWorkspaceExecutor(root))
      .run('go', parentChat, e => events.push(e));

    const results = events.filter(e => e.agentId && e.type === 'tool_result');
    const byId = (suffix: string) => results.find(e => e.toolCallId?.endsWith(`:${suffix}`));
    expect(byId('g1')?.toolError).toBe('sub_agent_git_blocked');
    expect(byId('g2')?.toolError).toBe('sub_agent_git_blocked');
    expect(byId('g3')?.toolSuccess).toBe(true);
  });

  it('命令之后没有再写入时导入验证证据；写入发生在命令之后则不导入', async () => {
    const { createLlm } = scriptedChildLlm({
      'FRESH': [
        calls([{ id: 'w', name: 'write_file', args: { path: 'f.ts', content: 'x' } }]),
        calls([{ id: 'c', name: 'run_command', args: { command: 'npm test' } }]),
        final(REPORT),
      ],
      'STALE': [
        calls([{ id: 'c', name: 'run_command', args: { command: 'npm test' } }]),
        calls([{ id: 'w', name: 'write_file', args: { path: 's.ts', content: 'x' } }]),
        final(REPORT),
      ],
    });
    for (const key of ['FRESH', 'STALE']) {
      const spawner = new AgentSpawner({
        parentSessionId: 'parent-session', sessionsDir, messageId: 'm1', createLlm,
        harnessFactory: realHarnessFactory(), leaseRegistry: new WriteLeaseRegistry(), persist: false,
      });
      const parent = { config: parentConfig(root, sessionsDir), toolExecutor: makeWorkspaceExecutor(root), workspaceRoot: root };
      await spawner.runTask({ id: `t-${key}`, name: 'task', arguments: { description: key, prompt: key } }, parent);
      const outcome = spawner.takeOutcome(`t-${key}`);
      expect(outcome?.filesChanged.length).toBe(1);
      if (key === 'FRESH') {
        expect(outcome?.freshEvidence.map(e => e.classification.command)).toEqual(['npm test']);
      } else {
        expect(outcome?.freshEvidence).toEqual([]);
      }
    }
  });
});

// ─── 并发、上限、取消、失败（桩 Harness） ───

interface StubControl {
  started: string[];
  active: number;
  maxActive: number;
}

function stubFactory(
  control: StubControl,
  behave: (prompt: string, config: HarnessConfig) => Promise<Partial<HarnessResult['loopState']> & { content?: string }>,
): AgentHarnessFactory {
  return (config): HarnessLike => ({
    getStopHookManager: () => new StopHookManager(),
    run: async (prompt) => {
      control.started.push(prompt);
      control.active++;
      control.maxActive = Math.max(control.maxActive, control.active);
      try {
        const r = await behave(prompt, config);
        return {
          content: r.content ?? REPORT,
          messages: [],
          log: [],
          loopState: {
            currentRound: r.currentRound ?? 3,
            totalInputTokens: 10,
            totalOutputTokens: 5,
            lastInputTokens: 0,
            lastOutputTokens: 0,
            totalToolCalls: 2,
            startTime: Date.now(),
            stopReason: r.stopReason ?? 'model_done',
          },
        } as HarnessResult;
      } finally {
        control.active--;
      }
    },
  });
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

describe('AgentSpawner 并发与生命周期', () => {
  const parentCtx = () => ({
    config: parentConfig(root, sessionsDir),
    toolExecutor: makeWorkspaceExecutor(root),
    workspaceRoot: root,
  });

  it('同时派出 6 个时最多 4 个并行，其余排队', async () => {
    const control: StubControl = { started: [], active: 0, maxActive: 0 };
    const spawner = new AgentSpawner({
      parentSessionId: 'p', sessionsDir, messageId: 'm', persist: false,
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: stubFactory(control, async () => { await sleep(40); return {}; }),
      maxConcurrent: 4,
    });
    const ctx = parentCtx();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      spawner.runTask({ id: `t${i}`, name: 'task', arguments: { description: `d${i}`, prompt: `p${i}` } }, ctx)));
    expect(control.maxActive).toBe(4);
    expect(results.every(r => r.success && r.output.includes('status=completed'))).toBe(true);
  });

  it('一次 run 派出超过上限时返回错误', async () => {
    const control: StubControl = { started: [], active: 0, maxActive: 0 };
    const spawner = new AgentSpawner({
      parentSessionId: 'p', sessionsDir, messageId: 'm', persist: false,
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: stubFactory(control, async () => ({})),
      maxPerRun: 2,
    });
    const ctx = parentCtx();
    const call = (i: number) => spawner.runTask({ id: `t${i}`, name: 'task', arguments: { description: 'd', prompt: 'p' } }, ctx);
    expect((await call(1)).success).toBe(true);
    expect((await call(2)).success).toBe(true);
    const third = await call(3);
    expect(third.success).toBe(false);
    expect(third.error).toContain('at most 2');
    spawner.beginParentRun();
    expect((await call(4)).success).toBe(true);
  });

  it('非法输入直接返回错误', async () => {
    const spawner = new AgentSpawner({
      parentSessionId: 'p', sessionsDir, messageId: 'm', persist: false,
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: stubFactory({ started: [], active: 0, maxActive: 0 }, async () => ({})),
    });
    const r = await spawner.runTask({ id: 't', name: 'task', arguments: { description: 'd' } }, parentCtx());
    expect(r.success).toBe(false);
  });

  it('停止单个子 Agent 只结束它自己；父中断结束全部', async () => {
    const control: StubControl = { started: [], active: 0, maxActive: 0 };
    const spawner = new AgentSpawner({
      parentSessionId: 'p', sessionsDir, messageId: 'm', persist: false, updateThrottleMs: 0,
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: stubFactory(control, async (prompt, config) => {
        if (prompt === 'quick') { await sleep(30); return {}; }
        await waitForAbort(config.loop.signal);
        return { stopReason: 'user_abort' };
      }),
    });
    const parentAbort = new AbortController();
    const views: string[] = [];
    const ctx = { ...parentCtx(), signal: parentAbort.signal, onStep: (e: HarnessStepEvent) => {
      if (e.type === 'agent_update' && e.agent?.status === 'running') views.push(e.agent.agentId);
    } };
    const slow = spawner.runTask({ id: 'a', name: 'task', arguments: { description: 'slow', prompt: 'slow' } }, ctx);
    const quick = spawner.runTask({ id: 'b', name: 'task', arguments: { description: 'quick', prompt: 'quick' } }, ctx);
    await sleep(10);
    expect(spawner.stop(views[0]!)).toBe(true);
    expect((await slow).output).toContain('status=cancelled');
    expect((await quick).output).toContain('status=completed');

    const c1 = spawner.runTask({ id: 'c', name: 'task', arguments: { description: 's1', prompt: 's1' } }, ctx);
    const c2 = spawner.runTask({ id: 'd', name: 'task', arguments: { description: 's2', prompt: 's2' } }, ctx);
    await sleep(10);
    parentAbort.abort();
    expect((await c1).output).toContain('status=cancelled');
    expect((await c2).output).toContain('status=cancelled');
  });

  it('超时 / 达到轮次上限 / 抛异常分别映射状态', async () => {
    const control: StubControl = { started: [], active: 0, maxActive: 0 };
    const spawner = new AgentSpawner({
      parentSessionId: 'p', sessionsDir, messageId: 'm', persist: false,
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: stubFactory(control, async (prompt) => {
        if (prompt === 'boom') throw new Error('kaboom');
        return { stopReason: prompt === 'slow' ? 'timeout' : 'max_rounds' };
      }),
    });
    const ctx = parentCtx();
    const run = (p: string) => spawner.runTask({ id: p, name: 'task', arguments: { description: p, prompt: p } }, ctx);
    expect((await run('slow')).output).toContain('status=timeout');
    expect((await run('long')).output).toContain('status=max_rounds');
    const boom = await run('boom');
    expect(boom.success).toBe(true);
    expect(boom.output).toContain('status=failed');
    expect(boom.output).toContain('error: kaboom');
  });

  it('子 Agent 超时被压到父剩余时长减 2 分钟', async () => {
    let seenTimeout = 0;
    const spawner = new AgentSpawner({
      parentSessionId: 'p', sessionsDir, messageId: 'm', persist: false,
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: stubFactory({ started: [], active: 0, maxActive: 0 }, async (_p, config) => {
        seenTimeout = config.loop.timeout ?? 0;
        return {};
      }),
    });
    await spawner.runTask(
      { id: 't', name: 'task', arguments: { description: 'd', prompt: 'p' } },
      { ...parentCtx(), deadline: Date.now() + 10 * 60 * 1000 },
    );
    expect(seenTimeout).toBeLessThanOrEqual(8 * 60 * 1000);
    expect(seenTimeout).toBeGreaterThan(7 * 60 * 1000);
  });

  it('子配置：checkpointOwner 指向父会话、记忆关闭、继承工作区锁定、不再嵌套', async () => {
    let seen: HarnessConfig | undefined;
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm', persist: false,
      createLlm: () => ({ chat: async () => final('x') }),
      harnessFactory: stubFactory({ started: [], active: 0, maxActive: 0 }, async (_p, config) => {
        seen = config;
        return {};
      }),
    });
    await spawner.runTask({ id: 't', name: 'task', arguments: { description: 'd', prompt: 'p' } }, {
      ...parentCtx(), lockedWorkspaceRoot: root, referenceReads: ['ref.md'],
    });
    expect(seen?.checkpointOwner).toEqual({ sessionDir: sessionsDir, sessionId: 'parent-session' });
    expect(seen?.memoryDisabled).toBe(true);
    expect(seen?.agentSpawner).toBeUndefined();
    expect(seen?.workspaceLock).toEqual({ lockedRoot: root, referenceReads: ['ref.md'] });
    expect(seen?.sessionDir).toBe(path.join(sessionsDir, 'parent-session', 'agents'));
    expect(seen?.sessionId?.startsWith('agent-')).toBe(true);
  });

  it('确认请求带来源子 Agent，拒绝会传回子 Agent', async () => {
    const onConfirm = vi.fn(async () => false);
    let childConfirm: HarnessConfig['onConfirm'];
    const spawner = new AgentSpawner({
      parentSessionId: 'p', sessionsDir, messageId: 'm', persist: false,
      createLlm: () => ({ chat: async () => final('x') }),
      onConfirm,
      harnessFactory: stubFactory({ started: [], active: 0, maxActive: 0 }, async (_p, config) => {
        childConfirm = config.onConfirm;
        expect(await config.onConfirm!('fs_operation', { operation: 'delete' })).toBe(false);
        return {};
      }),
    });
    await spawner.runTask({ id: 't', name: 'task', arguments: { description: '修复支付超时重试', prompt: 'p' } }, parentCtx());
    expect(childConfirm).toBeDefined();
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: '修复支付超时重试', type: 'general' }),
      'fs_operation',
      { operation: 'delete' },
      expect.any(AbortSignal),
    );
  });

  it('子 Agent 改完文件就想结束时，由停止验收替它跑 npm test', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }), 'utf-8');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/pay.js'), 'function pay() {\n  return 0;\n}\n', 'utf-8');
    const commands: string[] = [];
    const { createLlm } = scriptedChildLlm({
      'FIX-PAY': [
        calls([{ id: 'r', name: 'read_file', args: { path: 'src/pay.js' } }]),
        calls([{ id: 'w', name: 'write_file', args: { path: 'src/pay.js', content: 'function pay() {\n  return 1;\n}\n' } }]),
        final('Updated pay() to return 1.'),
      ],
    });
    const events: HarnessStepEvent[] = [];
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm-pay', createLlm,
      harnessFactory: realHarnessFactory(), persist: false,
    });
    let parentStep = 0;
    const parentChat: ChatFunction = async () => {
      parentStep += 1;
      return parentStep === 1 ? calls([taskCall('t', 'FIX-PAY')]) : final('parent done');
    };
    const result = await new Harness(
      parentConfig(root, sessionsDir, { agentSpawner: spawner, loop: { maxRounds: 8, timeout: 60_000 } }),
      makeWorkspaceExecutor(root, (args) => {
        commands.push(String(args.command ?? ''));
        return { success: true, output: JSON.stringify({ exitCode: 0, stdout: 'ok' }) };
      }),
    ).run('Fix src/pay.js so pay() returns 1.', parentChat, (e) => events.push(e));

    const taskOut = toolMessage(result.messages, 't');
    expect(taskOut).toContain('status=completed');
    expect(commands.some(command => command.includes('npm test'))).toBe(true);
    expect(events.some(e => e.agentId && e.type === 'tool_call' && e.toolName === 'run_command')).toBe(true);
    expect(await fs.readFile(path.join(root, 'src/pay.js'), 'utf-8')).toContain('return 1');
  });

  it('按用户消息清理子 Agent 的 meta 与对话记录', async () => {
    const { createLlm } = scriptedChildLlm({
      'KEEP': [final(REPORT)],
    });
    const spawner = new AgentSpawner({
      parentSessionId: 'parent-session', sessionsDir, messageId: 'm-keep', createLlm,
      harnessFactory: realHarnessFactory(),
    });
    await spawner.runTask(
      { id: 't', name: 'task', arguments: { description: 'keep', prompt: 'KEEP' } },
      parentCtx(),
    );
    const views = spawner.listViews();
    expect(views).toHaveLength(1);
    const agentId = views[0]!.agentId;
    expect(await loadAgentMeta(sessionsDir, 'parent-session', agentId)).not.toBeNull();
    expect(await loadAgentMessages(sessionsDir, 'parent-session', agentId)).not.toBeNull();

    const removed = await deleteAgentRecordsForMessages(sessionsDir, 'parent-session', ['m-keep']);
    expect(removed).toEqual([agentId]);
    expect(await loadAgentMeta(sessionsDir, 'parent-session', agentId)).toBeNull();
    expect(await loadAgentMessages(sessionsDir, 'parent-session', agentId)).toBeNull();
  });
});
