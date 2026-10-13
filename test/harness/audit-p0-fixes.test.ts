/**
 * Harness 审计 P0（#1–#9）回归测试。见 docs/harness/Harness-审计修复清单.md。
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolHandler } from '../../src/tools/types.js';
import { StreamingToolExecutor } from '../../src/harness/streaming-tool-executor.js';
import {
  containsExecutableEmbeddedToolCalls,
  parseEmbeddedToolCallsForExecution,
} from '../../src/harness/text-format-tool-call-parsers.js';
import { resolveSalvagedLlmResponse } from '../../src/harness/text-tool-call-salvage.js';
import {
  applyWorkspaceFileSnapshot,
  captureWorkspaceFileSnapshot,
  resolveInsideWorkspace,
} from '../../src/harness/workspace-snapshot.js';
import {
  isSafeIntentMessageId,
  loadCheckpointIndex,
  removeCheckpoint,
  saveIntentCheckpoint,
} from '../../src/harness/intent-checkpoint-store.js';
import { ProjectCheckpointStore } from '../../src/harness/project-checkpoint-store.js';
import { CheckpointEngine } from '../../src/harness/checkpoint-engine.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import { checkWorkspaceWriteBoundary } from '../../src/harness/harness-tool-preflight.js';
import type { IntentCheckpointArchive } from '../../src/types/intent-checkpoint.js';
import type { ProjectCheckpointV3 } from '../../src/types/runtime-checkpoint.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-audit-p0-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function executorWith(handler: ToolHandler, toolTimeout: number, maxRetries = 0): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: 'slow_tool', description: 'slow', parameters: { type: 'object', properties: {} } },
    handler,
  });
  return new ToolExecutor(registry, { maxRetries, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout });
}

describe('#1 tool timeout / abort', () => {
  it('returns after toolTimeout even if the handler never settles, and does not retry', async () => {
    const handler = vi.fn<ToolHandler>(() => new Promise(() => {}));
    const executor = executorWith(handler, 50, 3);
    const started = Date.now();
    const result = await executor.executeTool({ id: 't1', name: 'slow_tool', arguments: {} });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('超时');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes an AbortSignal to the handler that fires on timeout', async () => {
    let seen: AbortSignal | undefined;
    const executor = executorWith((_args, _onOutput, signal) => {
      seen = signal;
      return new Promise(() => {});
    }, 30);
    await executor.executeTool({ id: 't1', name: 'slow_tool', arguments: {} });
    expect(seen?.aborted).toBe(true);
  });

  it('stops promptly when the caller aborts', async () => {
    const executor = executorWith(() => new Promise(() => {}), 60_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const result = await executor.executeTool({ id: 't1', name: 'slow_tool', arguments: {} }, undefined, controller.signal);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('aborted');
  });

  it('StreamingToolExecutor forwards the harness abort signal to tools', async () => {
    const executor = executorWith(() => new Promise(() => {}), 60_000);
    const controller = new AbortController();
    const streaming = new StreamingToolExecutor(executor, undefined, controller.signal);
    streaming.submit({ id: 't1', name: 'slow_tool', arguments: {} });
    setTimeout(() => controller.abort(), 30);
    await streaming.flush();
    // flush 在 abort 时提前返回；工具 Promise 也必须随之结束，而不是挂在后台。
    const settled = await Promise.race([
      (streaming as unknown as { waitForAll: () => Promise<void> }).waitForAll().then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(settled).toBe(true);
  });
});

describe('#2 embedded tool-call salvage', () => {
  const tools = new Set(['read_file', 'write_file', 'run_command']);
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' };

  it('does not execute JSON examples inside an explanatory answer', () => {
    const explanation = [
      '要调用写文件工具，参数格式如下。name 是工具名，arguments 里放 path 和 content。',
      '注意 path 必须是相对工作区的路径，content 是完整文件内容，不支持增量写入。',
      '如果需要追加内容请改用 append_file，它的参数结构与 write_file 基本一致。',
      '```json',
      '{"name": "write_file", "arguments": {"path": "src/a.ts", "content": "x"}}',
      '```',
      '执行成功后工具会返回写入的字节数；失败时会返回错误原因，例如目录不存在或权限不足。',
    ].join('\n');
    expect(parseEmbeddedToolCallsForExecution(explanation, tools)).toEqual([]);
    expect(containsExecutableEmbeddedToolCalls(explanation)).toBe(false);
    const out = resolveSalvagedLlmResponse({ content: explanation, finishReason: 'stop', usage }, tools);
    expect(out.toolCalls ?? []).toHaveLength(0);
    expect(out.content).toBe(explanation);
  });

  it('still salvages a bare JSON tool call with little surrounding text', () => {
    const calls = parseEmbeddedToolCallsForExecution(
      '调用工具：\n```json\n{"tool": "run_command", "parameters": {"command": "npm test"}}\n```',
      tools,
    );
    expect(calls.map(c => c.name)).toEqual(['run_command']);
  });

  it('drops calls whose tool name is not available this round', () => {
    const text = '{"name": "delete_everything", "arguments": {}}';
    expect(parseEmbeddedToolCallsForExecution(text, tools)).toEqual([]);
    const out = resolveSalvagedLlmResponse({ content: text, finishReason: 'stop', usage }, tools);
    expect(out.toolCalls ?? []).toHaveLength(0);
  });

  it('explicit XML tool markup is always salvaged, even with long prose', () => {
    const text = `${'这是一段很长的说明。'.repeat(40)}\n<tool_call>\n<function=read_file>\n<parameter=path>a.ts</parameter>\n</function>\n</tool_call>`;
    const calls = parseEmbeddedToolCallsForExecution(text, tools);
    expect(calls.map(c => c.name)).toEqual(['read_file']);
    expect(containsExecutableEmbeddedToolCalls(text)).toBe(true);
  });
});

describe('#3 workspace snapshot path boundary', () => {
  it('resolveInsideWorkspace rejects traversal and foreign absolute paths', () => {
    const root = path.join(tempDir, 'ws');
    expect(resolveInsideWorkspace(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveInsideWorkspace(root, '../outside.txt')).toBeNull();
    expect(resolveInsideWorkspace(root, '../../x/../outside.txt')).toBeNull();
    expect(resolveInsideWorkspace(root, path.join(tempDir, 'outside.txt'))).toBeNull();
    expect(resolveInsideWorkspace(root, '')).toBeNull();
  });

  it('applyWorkspaceFileSnapshot never writes or deletes outside the workspace', async () => {
    const root = path.join(tempDir, 'ws');
    await fs.mkdir(root, { recursive: true });
    const victim = path.join(tempDir, 'victim.txt');
    await fs.writeFile(victim, 'original', 'utf-8');
    const outsideNew = path.join(tempDir, 'planted.txt');

    await applyWorkspaceFileSnapshot(
      root,
      {
        'inside.txt': 'restored',
        '../victim.txt': 'overwritten',
        [outsideNew]: 'planted',
      },
      ['../victim.txt'],
    );

    expect(await fs.readFile(path.join(root, 'inside.txt'), 'utf-8')).toBe('restored');
    expect(await fs.readFile(victim, 'utf-8')).toBe('original');
    expect(existsSync(outsideNew)).toBe(false);
  });

  it('captureWorkspaceFileSnapshot does not read files outside the workspace', async () => {
    const root = path.join(tempDir, 'ws');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'secret.txt'), 'secret', 'utf-8');
    const snapshot = await captureWorkspaceFileSnapshot(root, ['../secret.txt']);
    expect(Object.values(snapshot)).not.toContain('secret');
  });
});

function intentArchive(messageId: string): IntentCheckpointArchive {
  return {
    version: 1,
    messageId,
    sessionId: 's1',
    createdAt: '2026-10-13T00:00:00.000Z',
    userMessageTime: 1,
    userMessageContent: 'hi',
    uiMessages: [],
    structuredMessages: [],
    workspaceRoot: tempDir,
    trackedPaths: [],
    workspaceFiles: {},
  } as unknown as IntentCheckpointArchive;
}

describe('#4 intent checkpoint messageId', () => {
  it('isSafeIntentMessageId accepts UUIDs and rejects path-like ids', () => {
    expect(isSafeIntentMessageId('7f9c1d2e-0000-4a6b-9c1e-1234567890ab')).toBe(true);
    expect(isSafeIntentMessageId('msg_1.v2')).toBe(true);
    expect(isSafeIntentMessageId('../../evil')).toBe(false);
    expect(isSafeIntentMessageId('a/b')).toBe(false);
    expect(isSafeIntentMessageId('a\\b')).toBe(false);
    expect(isSafeIntentMessageId('C:evil')).toBe(false);
    expect(isSafeIntentMessageId('')).toBe(false);
    expect(isSafeIntentMessageId(null)).toBe(false);
  });

  it('refuses to write an archive for a traversal messageId', async () => {
    const sessionDir = path.join(tempDir, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await expect(saveIntentCheckpoint({
      sessionDir,
      sessionId: 's1',
      archive: intentArchive('../../escaped'),
    })).rejects.toThrow(/unsafe messageId/);
    expect(existsSync(path.join(tempDir, 'escaped.intent.json'))).toBe(false);
    expect(existsSync(path.join(sessionDir, 'escaped.intent.json'))).toBe(false);
  });

  it('does not unlink files named by a tampered archiveFileName in the index', async () => {
    const sessionDir = path.join(tempDir, 'sessions');
    await saveIntentCheckpoint({ sessionDir, sessionId: 's1', archive: intentArchive('m1') });
    const victim = path.join(tempDir, 'victim.json');
    await fs.writeFile(victim, '{}', 'utf-8');
    const indexFile = path.join(sessionDir, 's1.checkpoint-index.json');
    const index = await loadCheckpointIndex(sessionDir, 's1');
    index.entries[0]!.archiveFileName = '../../../victim.json';
    await fs.writeFile(indexFile, JSON.stringify(index), 'utf-8');

    await removeCheckpoint(sessionDir, 's1', 'm1');
    expect(existsSync(victim)).toBe(true);
  });
});

function projectCheckpoint(sessionId: string, goal: string): ProjectCheckpointV3 {
  return {
    version: 3,
    identity: { checkpointId: 'cp-1', projectId: 'project-1', sessionId },
    execution: {
      taskState: { goal, intent: 'edit', phase: 'editing', filesRead: [], filesChanged: [], commandsRun: [] },
      loopState: {
        currentRound: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        totalToolCalls: 0,
        startTime: 1,
      },
    },
    completion: { conditions: [], operationOutcomes: [] },
    conversation: { messages: [{ role: 'user', content: goal }] },
    workspace: {
      root: tempDir,
      repoContext: { filesRead: [], filesChanged: [], commandsRun: [], testCommands: [], recentDiagnostics: [] },
    },
    memory: {},
    snapshotMeta: { capturedAt: '2026-10-13T00:00:00.000Z', trigger: 'manual' },
    extensions: {},
    migration: null,
  };
}

describe('#5 checkpoint cache after clear', () => {
  it('clear() drops the cached aggregate so the next engine save does not resurrect it', async () => {
    const sessionId = 'resurrect';
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId });
    await store.save(projectCheckpoint(sessionId, 'OLD-GOAL-SHOULD-BE-GONE'), { generation: 1 });
    expect(store.latest()).not.toBeNull();

    await store.clear();
    expect(store.latest()).toBeNull();
    expect(existsSync(store.checkpointPath)).toBe(false);

    const engine = new CheckpointEngine(tempDir, sessionId);
    await engine.save({ trigger: 'manual' });
    const raw = await fs.readFile(store.checkpointPath, 'utf-8');
    expect(raw).not.toContain('OLD-GOAL-SHOULD-BE-GONE');
  });

  it('clear() is a no-op when the session dir does not exist', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: path.join(tempDir, 'missing'), sessionId: 's' });
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

function compactor(): ContextCompactor {
  return new ContextCompactor({
    threshold: 9999,
    keepRecent: 2,
    keepRecentMinTokens: 1,
    keepRecentMaxTokens: 100_000,
    keepRecentMinMessages: 2,
    enableLLMSummary: false,
    maxReinjectFiles: 0,
    maxReinjectTokens: 0,
  });
}

function assertToolPairsIntact(messages: UnifiedMessage[]): void {
  const callIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant') for (const tc of msg.toolCalls ?? []) callIds.add(tc.id);
    if (msg.role === 'tool') expect(callIds.has(msg.toolCallId ?? '')).toBe(true);
  }
}

describe('#6 forced compaction keeps tool_call / tool_result pairs', () => {
  it('does not split an assistant(tool_calls) from its tool results', () => {
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'next' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'g1', name: 'grep', arguments: { pattern: 'foo' } },
          { id: 'g2', name: 'grep', arguments: { pattern: 'bar' } },
        ],
      },
      { role: 'tool', toolCallId: 'g1', content: 'r1' },
      { role: 'tool', toolCallId: 'g2', content: 'r2' },
    ];
    const result = compactor().compactWithSessionMemory(messages, 'notes body', { forceFullCompact: true });
    expect(result.some(m => typeof m.content === 'string' && m.content.includes('<context-summary>'))).toBe(true);
    assertToolPairsIntact(result);
    const g1 = result.find(m => m.role === 'tool' && m.toolCallId === 'g1');
    expect(g1?.content).toBe('r1');
  });
});

describe('#7 microcompact keeps identifying tool arguments', () => {
  it('structural summary still mentions the paths and commands of dropped tool calls', async () => {
    const big = 'x'.repeat(2_000);
    const messages: UnifiedMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `step ${i}` });
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'run_command', arguments: { command: `npm run task-${i}`, stdin: big } }],
      });
      messages.push({ role: 'tool', toolCallId: `c${i}`, content: `ok ${i}` });
    }
    const result = await compactor().compact(messages, undefined, undefined, { forceFullCompact: true });
    const summary = result.find(m => typeof m.content === 'string' && m.content.startsWith('<context-summary>'));
    expect(String(summary?.content)).toContain('npm run task-0');
    expect(String(summary?.content)).not.toContain(big);
  });
});

describe('#8 session-notes cursor', () => {
  it('does not advance lastProcessedIndex when the LLM draft fails validation', async () => {
    const integration = new HarnessMemoryIntegration({
      memoryDir: path.join(tempDir, 'memory'),
      sessionDir: tempDir,
      sessionId: 'notes-cursor',
    });
    const chat = vi.fn().mockResolvedValue({ content: 'not a valid notes document' });
    (integration as unknown as { llmAdapter: unknown }).llmAdapter = { chat };
    const state = (integration as unknown as {
      sessionMemoryState: { lastProcessedIndex: number; tokensAtLastExtraction: number };
    }).sessionMemoryState;
    const before = { index: state.lastProcessedIndex, tokens: state.tokensAtLastExtraction };

    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'please refactor the parser module and keep tests green' },
      { role: 'assistant', content: 'working on it' },
    ];
    await integration.maybeUpdateSessionMemory(messages, 50_000, true);

    expect(chat).toHaveBeenCalled();
    expect(state.lastProcessedIndex).toBe(before.index);
    expect(state.tokensAtLastExtraction).toBe(before.tokens);
    integration.dispose();
  });
});

describe('#9 workspace write boundary', () => {
  const root = () => path.join(tempDir, 'ws');

  beforeEach(async () => {
    await fs.mkdir(root(), { recursive: true });
  });

  const check = (toolName: string, args: Record<string, unknown>, locked = true) =>
    checkWorkspaceWriteBoundary({
      toolName,
      args,
      workspaceRoot: root(),
      lockedWorkspaceRoot: locked ? root() : undefined,
    });

  it('allows writes inside the locked workspace', () => {
    expect(check('write_file', { path: 'src/a.ts' }).blocked).toBe(false);
    expect(check('edit_file', { path: path.join(root(), 'b.ts') }).blocked).toBe(false);
  });

  it('blocks writes outside the locked workspace', () => {
    expect(check('write_file', { path: '../evil.ts' })).toMatchObject({ blocked: true, reason: 'outside_workspace' });
    expect(check('patch_file', { path: path.join(tempDir, 'evil.ts') }).blocked).toBe(true);
    expect(check('fs_operation', { operation: 'move', path: 'a.ts', target: '../out.ts' }).blocked).toBe(true);
    expect(check('fs_operation', { operation: 'delete', path: '../victim.txt' }).blocked).toBe(true);
  });

  it('does not restrict reads, listings, or unlocked sessions', () => {
    expect(check('read_file', { path: '../anything.ts' }).blocked).toBe(false);
    expect(check('fs_operation', { operation: 'list', path: '..' }).blocked).toBe(false);
    expect(check('write_file', { path: '../evil.ts' }, false).blocked).toBe(false);
  });

  it('blocks writes through a junction / symlink that points outside', async () => {
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    const link = path.join(root(), 'linked');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    expect(check('write_file', { path: 'linked/evil.ts' }).blocked).toBe(true);
  });
});
