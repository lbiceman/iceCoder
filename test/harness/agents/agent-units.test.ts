import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ToolDefinition } from '../../../src/llm/types.js';
import { agentConfig, resolveAgentLimits } from '../../../src/harness/agents/agent-config.js';
import {
  EXPLORE_AGENT_TYPE,
  GENERAL_AGENT_TYPE,
  filterToolsForAgentType,
} from '../../../src/harness/agents/agent-types.js';
import { findBlockedSubAgentGitSubcommand } from '../../../src/harness/agents/agent-git-policy.js';
import { importAgentVerificationEvidence, mergeAgentFileChanges } from '../../../src/harness/agents/agent-merge.js';
import { countLineChanges, formatAgentResult, mapStopReasonToAgentStatus } from '../../../src/harness/agents/agent-result.js';
import {
  deleteAgentRecordsForMessages,
  listAgentMetas,
  normalizeInterruptedAgentMeta,
  saveAgentMessages,
  saveAgentMeta,
  type AgentMetaRecord,
} from '../../../src/harness/agents/agent-store.js';
import { parseTaskToolInput } from '../../../src/harness/agents/task-tool.js';
import { WriteLeaseRegistry } from '../../../src/harness/agents/write-lease.js';
import { TaskState } from '../../../src/harness/task-state.js';
import { RepoContext } from '../../../src/harness/repo-context.js';
import { createVerificationRuntimeState } from '../../../src/harness/verification-state.js';
import { classifyToolRoundProgress } from '../../../src/harness/tool-round-progress.js';
import { GraphExecutor } from '../../../src/harness/task-graph-executor.js';
import { aggregateTokenUsageByRole, tokenUsageEventsToRecords } from '../../../src/web/token-usage-stats.js';
import { isConcurrencySafe } from '../../../src/tools/tool-metadata.js';
import { alignPromptWithAvailableTools } from '../../../src/prompts/prompt-assembler.js';

const tool = (name: string): ToolDefinition => ({ name, description: name, parameters: { type: 'object', properties: {} } });

describe('agent-types', () => {
  const all = [
    'read_file', 'write_file', 'edit_file', 'run_command', 'grep', 'glob', 'fs_operation', 'git',
    'task', 'request_analysis', 'memory_write', 'remember_this', 'ask_user', 'enter_plan_mode',
    'mcp_github_list_issues', 'mcp_github_create_issue', 'mcp_browser_click',
  ].map(tool);

  it('general 去掉 task / 记忆 / 提问 / 模式切换', () => {
    const names = filterToolsForAgentType(GENERAL_AGENT_TYPE, all).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command', 'git', 'mcp_github_create_issue']));
    for (const n of ['task', 'request_analysis', 'memory_write', 'remember_this', 'ask_user', 'enter_plan_mode']) {
      expect(names).not.toContain(n);
    }
  });

  it('explore 只保留只读工具（含只读 MCP）', () => {
    const names = filterToolsForAgentType(EXPLORE_AGENT_TYPE, all).map(t => t.name);
    expect(names.sort()).toEqual(['fs_operation', 'glob', 'grep', 'mcp_github_list_issues', 'read_file'].sort());
  });

  it('默认上限与父剩余时长压缩', () => {
    expect(resolveAgentLimits(GENERAL_AGENT_TYPE)).toMatchObject({ maxRounds: 2000, timeoutMs: 4 * 3600_000, tokenBudget: 20_000_000 });
    expect(resolveAgentLimits(EXPLORE_AGENT_TYPE)).toMatchObject({ maxRounds: 300, timeoutMs: 30 * 60_000 });
    const now = 1_000_000;
    const limits = resolveAgentLimits(GENERAL_AGENT_TYPE, { parentDeadline: now + 30 * 60_000, now });
    expect(limits.timeoutMs).toBe(30 * 60_000 - agentConfig.parentDeadlineMarginMs);
  });
});

describe('task 工具输入', () => {
  it('默认 general；缺 prompt 报错；未知类型报错', () => {
    const ok = parseTaskToolInput({ description: 'x', prompt: 'do' });
    expect(ok.ok && ok.input.subagentType.name).toBe('general');
    expect(parseTaskToolInput({ description: 'x' }).ok).toBe(false);
    expect(parseTaskToolInput({ description: 'x', prompt: 'p', subagent_type: 'nope' }).ok).toBe(false);
  });

  it('task 并发安全', () => {
    expect(isConcurrencySafe('task')).toBe(true);
  });
});

describe('git 限制', () => {
  const call = (name: string, args: Record<string, unknown>) => ({ id: '1', name, arguments: args });
  it.each([
    ['git', { subcommand: 'commit' }, 'commit'],
    ['git', { subcommand: 'checkout' }, 'checkout'],
    ['run_command', { command: 'git push origin main' }, 'push'],
    ['run_command', { command: 'npm test && git -C sub stash' }, 'stash'],
    ['run_command', { command: 'git --no-pager reset --hard' }, 'reset'],
  ])('%s %o → %s', (name, args, expected) => {
    expect(findBlockedSubAgentGitSubcommand(call(name, args))).toBe(expected);
  });

  it.each([
    ['git', { subcommand: 'status' }],
    ['git', { subcommand: 'diff' }],
    ['run_command', { command: 'git log --oneline' }],
    ['run_command', { command: 'echo commit' }],
  ])('允许 %s %o', (name, args) => {
    expect(findBlockedSubAgentGitSubcommand(call(name, args))).toBeNull();
  });
});

describe('写租约', () => {
  it('同一文件只能被一个 Agent 持有；释放后可再取', () => {
    const leases = new WriteLeaseRegistry();
    expect(leases.acquire('/ws', 'a.ts', { agentId: 'A', description: 'a' }).ok).toBe(true);
    expect(leases.acquire('/ws', './a.ts', { agentId: 'A', description: 'a' }).ok).toBe(true);
    const rejected = leases.acquire('/ws', 'a.ts', { agentId: 'B', description: 'b' });
    expect(rejected.ok).toBe(false);
    leases.releaseAgent('A');
    expect(leases.acquire('/ws', 'a.ts', { agentId: 'B', description: 'b' }).ok).toBe(true);
  });
});

describe('结果汇总', () => {
  it('行统计忽略末尾换行', () => {
    expect(countLineChanges(null, 'a\nb\n')).toEqual({ additions: 2, deletions: 0 });
    expect(countLineChanges('a\nb\n', 'a\nc\n')).toEqual({ additions: 1, deletions: 1 });
  });

  it('状态映射', () => {
    expect(mapStopReasonToAgentStatus('model_done').status).toBe('completed');
    expect(mapStopReasonToAgentStatus('user_abort').status).toBe('cancelled');
    expect(mapStopReasonToAgentStatus('model_done', 'timeout').status).toBe('timeout');
    expect(mapStopReasonToAgentStatus('circuit_breaker' as never)).toEqual({ status: 'failed', reason: 'circuit_breaker' });
  });

  it('[Agent Result] 截断超长报告', () => {
    const text = formatAgentResult({
      agentId: 'x', type: 'general', status: 'completed', durationMs: 61_000, rounds: 3, toolCalls: 4, tokens: 1500,
      filesChanged: [], commands: [{ toolCallId: 'c', command: 'npm test', exitCode: 1, success: false }],
      leaseRejects: [], commandConflicts: [], report: 'r'.repeat(20_000), transcriptPath: '/t.json',
    });
    expect(text).toContain('duration=1m1s rounds=3 toolCalls=4 tokens=1.5K');
    expect(text).toContain('commands: npm test → exit 1');
    expect(text).toContain('[report truncated; full transcript: /t.json]');
  });
});

describe('合并到父状态', () => {
  it('改动文件进入父 TaskState / RepoContext，并推进 mutation version', () => {
    const taskState = new TaskState('goal');
    const repoContext = new RepoContext();
    const before = taskState.snapshot().workspaceMutationVersion;
    mergeAgentFileChanges('t1', {
      agentId: 'A',
      filesChanged: [
        { path: 'src/a.ts', additions: 3, deletions: 1 },
        { path: 'src/old.ts', additions: 0, deletions: 5, deleted: true },
      ],
      freshEvidence: [],
    }, { taskState, repoContext });
    expect(taskState.snapshot().filesChanged).toContain('src/a.ts');
    expect(repoContext.snapshot().filesChanged).toContain('src/a.ts');
    expect(taskState.snapshot().workspaceMutationVersion).toBeGreaterThan(before);
  });

  it('新鲜证据按计划命令导入', () => {
    const state = createVerificationRuntimeState();
    const plan = {
      id: 'p', source: 'project' as const, fingerprint: 'fp',
      commands: [{ command: 'npm test', required: true, timeoutMs: 1000 }],
    };
    const imported = importAgentVerificationEvidence({
      agentId: 'A',
      filesChanged: [],
      freshEvidence: [{ toolCallId: 'c', classification: { kind: 'foreground', command: 'npm test', foregroundSuccess: true, exitCode: 0 } }],
    }, state, plan);
    expect(imported).toBe(1);
    expect(state.commandProgress[0]).toMatchObject({ command: 'npm test', status: 'passed', evidenceRef: 'A:c' });
    expect(importAgentVerificationEvidence({ agentId: 'A', filesChanged: [], freshEvidence: [] }, state, null)).toBe(0);
  });
});

describe('中性工具', () => {
  it('task 算有效进展', () => {
    expect(classifyToolRoundProgress({
      executableToolCalls: [{ id: '1', name: 'task', arguments: {} }],
      failedSignatures: [],
    })).toBe('meaningful_progress');
  });

  it('TaskGraph 不约束 task', () => {
    const graph = new GraphExecutor();
    expect(graph.checkToolCall('task').action).toBe('allow');
  });
});

describe('主 Agent 提示词', () => {
  it('有 task 时加入 Sub-agents 段，没有时去掉', () => {
    const base = {
      systemPrompt: 'tools',
      systemPromptSections: [{ id: 'tool_usage', priority: 30, content: 'tools', enabled: true }],
    } as unknown as Parameters<typeof alignPromptWithAvailableTools>[0];
    const withTask = alignPromptWithAvailableTools(base, ['read_file', 'task']);
    expect(withTask.systemPromptSections.map(s => s.id)).toContain('sub_agents');
    expect(withTask.systemPrompt).toContain('# Sub-agents');
    const without = alignPromptWithAvailableTools(withTask, ['read_file']);
    expect(without.systemPromptSections.map(s => s.id)).not.toContain('sub_agents');
  });
});

describe('用量按角色拆分', () => {
  it('带 agentId 的记录计入子 Agent', () => {
    const now = Date.now();
    const records = tokenUsageEventsToRecords([
      { type: 'token_usage', timestamp: new Date(now - 1000).toISOString(), source: 'chat', inputTokens: 100, outputTokens: 10 },
      { type: 'token_usage', timestamp: new Date(now - 1000).toISOString(), source: 'sub_agent', inputTokens: 50, outputTokens: 5, agentId: 'A', agentType: 'general' },
      { type: 'token_usage', timestamp: new Date(now - 1000).toISOString(), source: 'compaction', inputTokens: 7, outputTokens: 3, agentId: 'A' },
    ]);
    const byRole = aggregateTokenUsageByRole(records, now);
    expect(byRole.main.day.totalTokens).toBe(110);
    expect(byRole.subAgent.day.totalTokens).toBe(65);
  });
});

describe('agents 目录', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-agent-store-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const meta = (agentId: string, messageId: string, status: AgentMetaRecord['status'] = 'completed'): AgentMetaRecord => ({
    agentId, parentToolCallId: 't', messageId, type: 'general', description: 'd', status,
    startedAt: Date.now(), rounds: 1, toolCalls: 1, tokens: 1, filesChanged: [], commands: [], leaseRejects: 0,
    parentSessionId: 's1', childSessionId: `agent-${agentId}`, prompt: 'p', updatedAt: Date.now(),
  });

  it('按 messageId 删除 meta 与结构化消息', async () => {
    await saveAgentMeta(dir, meta('a1', 'm1'));
    await saveAgentMeta(dir, meta('a2', 'm2'));
    await saveAgentMessages(dir, 's1', 'a1', [{ role: 'user', content: 'x' }]);
    const removed = await deleteAgentRecordsForMessages(dir, 's1', ['m1']);
    expect(removed).toEqual(['a1']);
    const names = await fs.readdir(path.join(dir, 's1', 'agents'));
    expect(names.some(n => n.startsWith('a1.') || n.startsWith('agent-a1.'))).toBe(false);
    expect((await listAgentMetas(dir, 's1')).map(m => m.agentId)).toEqual(['a2']);
  });

  it('进程退出时仍为 running 的记录标为已中断', () => {
    const normalized = normalizeInterruptedAgentMeta(meta('a', 'm', 'running'), () => false);
    expect(normalized).toMatchObject({ status: 'cancelled', interrupted: true });
    expect(normalizeInterruptedAgentMeta(meta('a', 'm', 'running'), () => true).status).toBe('running');
  });
});
