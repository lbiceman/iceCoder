/**
 * Harness 审计 P1（#34–#39）回归测试。见 docs/harness/Harness-审计修复清单.md。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const broadcasts: unknown[] = [];

vi.mock('../../src/web/chat-ws-broadcast.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/chat-ws-broadcast.js')>()),
  broadcastToSession: (_sid: string, data: unknown) => {
    broadcasts.push(data);
  },
  hasSessionSubscribers: () => true,
}));

import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import { createTaskGraph, startCurrentNode } from '../../src/harness/task-graph.js';
import type { TaskGraph, TaskNode } from '../../src/types/task-graph.js';
import { findBlockedSubAgentGitSubcommand } from '../../src/harness/agents/agent-git-policy.js';
import { AgentSpawner, type AgentHarnessFactory } from '../../src/harness/agents/agent-spawner.js';
import { AgentBackgroundHub } from '../../src/harness/agents/agent-background-hub.js';
import { StopHookManager } from '../../src/harness/stop-hooks.js';
import type { HarnessConfig, HarnessResult } from '../../src/harness/types.js';
import type { ToolCall, ToolDefinition } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolResult } from '../../src/tools/types.js';
import { clearRuntimeOnShutdown, sessionAgentSpawners } from '../../src/web/chat-ws-runtime.js';

// ─── helpers ───

const REPORT = '1. **Conclusion** — done.\n2. **Changes** — none.\n3. **Verification** — none.\n4. **Open issues / risks** — none.';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function tool(name: string): ToolDefinition {
  return { name, description: name, parameters: { type: 'object', properties: {} } };
}

function workspaceExecutor(root: string, onCommand?: (command: string) => Promise<void>): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register({
    definition: tool('write_file'),
    handler: async (args) => {
      const abs = path.resolve(root, String(args.path));
      await fs.writeFile(abs, String(args.content ?? ''), 'utf-8');
      return { success: true, output: `wrote ${args.path}` };
    },
  });
  registry.register({
    definition: tool('run_command'),
    handler: async (args) => {
      await onCommand?.(String(args.command));
      return { success: true, output: JSON.stringify({ exitCode: 0, stdout: 'ok' }) };
    },
  });
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

function parentConfig(root: string, sessionsDir: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    context: { systemPrompt: 'parent', tools: [tool('write_file'), tool('run_command')] },
    loop: { maxRounds: 50, timeout: 10 * 60 * 1000 },
    sessionDir: sessionsDir,
    sessionId: 'parent-session',
    workspaceRoot: root,
    ...overrides,
  };
}

type Behave = (prompt: string, config: HarnessConfig, executor: ToolExecutor) => Promise<void>;

function stubHarness(behave: Behave): AgentHarnessFactory {
  return (config, executor) => ({
    getStopHookManager: () => new StopHookManager(),
    run: async (prompt): Promise<HarnessResult> => {
      await behave(prompt, config, executor);
      return {
        content: REPORT,
        messages: [],
        log: [],
        loopState: {
          currentRound: 1,
          totalInputTokens: 1,
          totalOutputTokens: 1,
          lastInputTokens: 0,
          lastOutputTokens: 0,
          totalToolCalls: 1,
          startTime: Date.now(),
          stopReason: 'model_done',
        },
      } as HarnessResult;
    },
  });
}

function makeSpawner(sessionId: string, sessionsDir: string, behave: Behave, extra: Record<string, unknown> = {}) {
  let t = 1_000;
  return new AgentSpawner({
    parentSessionId: sessionId,
    sessionsDir,
    messageId: 'm',
    persist: false,
    updateThrottleMs: 0,
    now: () => ++t,
    createLlm: () => ({ chat: async () => ({ content: 'x', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 't' }, finishReason: 'stop' }) }),
    harnessFactory: stubHarness(behave),
    ...extra,
  });
}

function taskCall(id: string, prompt: string): ToolCall {
  return { id, name: 'task', arguments: { description: prompt, prompt } };
}

let tmp: string;
let root: string;
let sessionsDir: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-audit-p1-agents-'));
  root = path.join(tmp, 'ws');
  sessionsDir = path.join(tmp, 'sessions');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  broadcasts.length = 0;
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

// ─── #34 ───

function graphNode(id: string, type: TaskNode['type']): TaskNode {
  return {
    id, type, title: id, phase: 'editing', requiresTool: true,
    status: 'pending', retryCount: 0, maxRetries: 1,
  };
}

function executorWithGraph(nodes: TaskNode[]): { ex: GraphExecutor; graph: TaskGraph } {
  const ex = new GraphExecutor();
  const graph = createTaskGraph({ goal: 'g', intent: 'edit', nodes, graphId: 'g1' });
  startCurrentNode(graph);
  (ex as unknown as { graph: TaskGraph }).graph = graph;
  return { ex, graph };
}

function driveUntilForceSwitch(ex: GraphExecutor) {
  for (let i = 0; i < 20; i++) {
    ex.checkToolCall('edit_file');
    const r = ex.evaluateRound(1);
    if (r.action === 'force_switch') return r;
  }
  return undefined;
}

describe('#34 force_switch 时 fallback 分支真正激活', () => {
  it('当前节点仍 running 时 force_switch 也切到 fallback 分支并启动其节点', () => {
    const { ex, graph } = executorWithGraph([graphNode('n1', 'edit'), graphNode('fb1', 'fallback')]);
    expect(graph.nodes.n1!.status).toBe('running');

    const r = driveUntilForceSwitch(ex);
    expect(r?.fallbackActivated).toBe(true);
    expect(graph.cursor.branchId).toContain('branch-fallback');
    expect(graph.cursor.nodeId).toBe('fb1');
    expect(graph.nodes.n1!.status).toBe('failed');
    expect(graph.nodes.fb1!.status).toBe('running');
    expect(graph.status).toBe('running');
    expect(ex.isTerminal()).toBe(false);
  });

  it('fallback 用尽后再次 force_switch 判图失败', () => {
    const { ex, graph } = executorWithGraph([graphNode('n1', 'edit'), graphNode('fb1', 'fallback')]);
    expect(driveUntilForceSwitch(ex)?.fallbackActivated).toBe(true);
    expect(driveUntilForceSwitch(ex)?.fallbackActivated).toBe(false);
    expect(graph.status).toBe('failed');
    expect(graph.nodes.fb1!.status).toBe('failed');
  });

  it('没有 fallback 节点时仍判图失败', () => {
    const { ex, graph } = executorWithGraph([graphNode('n1', 'edit')]);
    expect(driveUntilForceSwitch(ex)?.fallbackActivated).toBe(false);
    expect(graph.status).toBe('failed');
  });
});

// ─── #35 ───

describe('#35 git 限制覆盖嵌套 shell / 前缀 / 完整路径', () => {
  const run = (command: string) => findBlockedSubAgentGitSubcommand({ id: 't', name: 'run_command', arguments: { command } });
  const encoded = Buffer.from('git push origin main', 'utf16le').toString('base64');

  it.each([
    ['bash -c "git commit -m x"', 'commit'],
    ["sh -lc 'cd sub && git rebase main'", 'rebase'],
    ['pwsh -NoProfile -Command "git push origin main"', 'push'],
    ['powershell -ExecutionPolicy Bypass -c "npm test; git stash"', 'stash'],
    [`powershell -EncodedCommand ${encoded}`, 'push'],
    ['cmd /c git reset --hard', 'reset'],
    ['cmd.exe /S /C "git checkout main"', 'checkout'],
    ['cmd /c"git clean -fd"', 'clean'],
    ['FOO=1 git commit -m x', 'commit'],
    ['npx -y git checkout -b x', 'checkout'],
    ['env GIT_DIR=.git git merge dev', 'merge'],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" commit -m x', 'commit'],
    ["& 'C:\\Program Files\\Git\\cmd\\git.exe' pull", 'pull'],
    ['echo $(git stash)', 'stash'],
    ['echo "result: $(git commit -am x)"', 'commit'],
    ['npm test & git push', 'push'],
    ['eval "git revert HEAD"', 'revert'],
    ['bash -c "bash -c \\"git cherry-pick abc\\""', 'cherry-pick'],
  ])('%s → %s', (command, expected) => {
    expect(run(command)).toBe(expected);
  });

  it.each([
    'echo "git commit"',
    "echo 'run git push later'",
    'git status && git diff',
    'bash -c "git log --oneline"',
    'pwsh -Command "git status"',
    'cmd /c git branch -a',
    'npm test',
  ])('不拦截：%s', (command) => {
    expect(run(command)).toBeNull();
  });
});

// ─── #36 ───

describe('#36 写租约表按会话隔离', () => {
  it('两个会话各自 spawner 的租约互不影响；同一会话内仍互斥', async () => {
    const holderWrote = deferred();
    const release = deferred();
    const checks: Record<string, unknown> = {};
    const writeCall: ToolCall = { id: 'w', name: 'write_file', arguments: { path: 'x.txt', content: 'A' } };

    const behave: Behave = async (prompt, config, executor) => {
      if (prompt === 'holder') {
        expect(config.agentScope!.checkBeforeTool(writeCall)).toBeNull();
        await executor.executeTool(writeCall);
        holderWrote.resolve();
        await release.promise;
        return;
      }
      await holderWrote.promise;
      checks[prompt] = config.agentScope!.checkBeforeTool({ ...writeCall, id: `w-${prompt}` });
    };
    const ctx = { config: parentConfig(root, sessionsDir), toolExecutor: workspaceExecutor(root), workspaceRoot: root };
    const sessionA = makeSpawner('session-a', sessionsDir, behave);
    const sessionB = makeSpawner('session-b', sessionsDir, behave);

    const holder = sessionA.runTask(taskCall('t1', 'holder'), ctx);
    await sessionB.runTask(taskCall('t2', 'other-session'), ctx);
    await sessionA.runTask(taskCall('t3', 'same-session'), ctx);
    release.resolve();
    await holder;

    expect(checks['other-session']).toBeNull();
    expect(checks['same-session']).toMatchObject({ reason: 'agent_write_lease' });
  });
});

// ─── #37 ───

describe('#37 run_command 改动他人租约文件时该次命令失败', () => {
  it('命令改了别的子 Agent 已写过的文件 → 工具结果 success=false 并说明冲突；只改自己的文件不受影响', async () => {
    const holderWrote = deferred();
    const release = deferred();
    const results: Record<string, ToolResult> = {};
    const toolExecutor = workspaceExecutor(root, async (command) => {
      if (command === 'clobber') await fs.writeFile(path.join(root, 'shared.txt'), 'B', 'utf-8');
      if (command === 'own') await fs.writeFile(path.join(root, 'own.txt'), 'C', 'utf-8');
    });

    const spawner = makeSpawner('s', sessionsDir, async (prompt, config, executor) => {
      if (prompt === 'holder') {
        const tc: ToolCall = { id: 'w1', name: 'write_file', arguments: { path: 'shared.txt', content: 'A' } };
        expect(config.agentScope!.checkBeforeTool(tc)).toBeNull();
        await executor.executeTool(tc);
        holderWrote.resolve();
        await release.promise;
        return;
      }
      await holderWrote.promise;
      results.clobber = await executor.executeTool({ id: 'c1', name: 'run_command', arguments: { command: 'clobber' } });
      results.own = await executor.executeTool({ id: 'c2', name: 'run_command', arguments: { command: 'own' } });
      release.resolve();
    });
    const ctx = { config: parentConfig(root, sessionsDir), toolExecutor, workspaceRoot: root };

    await Promise.all([
      spawner.runTask(taskCall('t1', 'holder'), ctx),
      spawner.runTask(taskCall('t2', 'runner'), ctx),
    ]);

    expect(results.clobber!.success).toBe(false);
    expect(results.clobber!.error).toContain('[Harness / Write Lease]');
    expect(results.clobber!.error).toContain('shared.txt');
    expect(results.clobber!.output).toContain('exitCode');
    expect(results.own!.success).toBe(true);
  });
});

// ─── #38 ───

describe('#38 后台登记处回收与关停 dispose', () => {
  it('终态且报告已取走的登记被移除；仍在跑的保留', () => {
    const hub = new AgentBackgroundHub();
    const base = { sessionId: 's', type: 'general', description: 'd' };
    hub.register({ ...base, agentId: 'a1', toolCallId: 't1', startedAt: 1 });
    hub.register({ ...base, agentId: 'a2', toolCallId: 't2', startedAt: 2 });
    hub.finish('a1', 'completed', 'OUT1');

    expect(hub.drainOutputs('s').map(d => d.agentId)).toEqual(['a1']);
    expect(hub.get('a1')).toBeUndefined();
    expect(hub.list('s').map(e => e.agentId)).toEqual(['a2']);

    hub.finish('a2', 'failed', 'OUT2');
    expect(hub.takeOutput('a2')).toBe('OUT2');
    expect(hub.get('a2')).toBeUndefined();
    expect(hub.list('s')).toEqual([]);
  });

  it('clearRuntimeOnShutdown 逐个 dispose 会话 spawner 并清空', () => {
    const dispose = vi.fn();
    const throwing = vi.fn(() => { throw new Error('boom'); });
    sessionAgentSpawners.set('shutdown-a', { dispose: throwing } as unknown as AgentSpawner);
    sessionAgentSpawners.set('shutdown-b', { dispose } as unknown as AgentSpawner);

    clearRuntimeOnShutdown();

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(sessionAgentSpawners.size).toBe(0);
  });
});

// ─── #39 ───

describe('#39 子 Agent 停止时撤掉挂着的确认', () => {
  it('回落到父 onConfirm 时也传入 signal；停止子 Agent 后确认被撤销并按拒绝处理', async () => {
    let received: AbortSignal | undefined;
    let revoked = false;
    let confirmResult: boolean | undefined;
    const parentOnConfirm = (_tool: string, _args: Record<string, any>, signal?: AbortSignal) => {
      received = signal;
      return new Promise<boolean>(resolve => {
        signal?.addEventListener('abort', () => { revoked = true; resolve(false); }, { once: true });
      });
    };
    const spawner = makeSpawner('s', sessionsDir, async (_prompt, config) => {
      confirmResult = await config.onConfirm!('write_file', { path: 'a.txt' });
    });
    const ctx = {
      config: parentConfig(root, sessionsDir, { onConfirm: parentOnConfirm }),
      toolExecutor: workspaceExecutor(root),
      workspaceRoot: root,
    };

    const pending = spawner.runTask(taskCall('t1', 'confirmer'), ctx);
    for (let i = 0; i < 50 && !received; i++) await sleep(5);
    expect(received).toBeInstanceOf(AbortSignal);
    expect(spawner.stop(spawner.listViews()[0]!.agentId)).toBe(true);
    await pending;

    expect(received!.aborted).toBe(true);
    expect(revoked).toBe(true);
    expect(confirmResult).toBe(false);
  });

  it('Web 普通确认通道接受 signal：abort 后撤掉 pending 确认并广播 cancelled', async () => {
    const { createToolConfirmHandler } = await import('../../src/web/chat-ws-confirm.js');
    const ctrl = new AbortController();
    const pending = createToolConfirmHandler('sess-audit-39')('fs_operation', {}, ctrl.signal);
    expect(broadcasts.some(b => (b as { type?: string }).type === 'confirm')).toBe(true);

    ctrl.abort();
    const outcome = await Promise.race([pending, sleep(200).then(() => 'still-pending' as const)]);
    expect(outcome).toBe(false);
    const resolved = broadcasts.find(b => (b as { type?: string }).type === 'confirm_resolved') as { reason?: string } | undefined;
    expect(resolved?.reason).toBe('cancelled');
  });
});
