import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  fenceSkillsUnderAgent,
  filterToolsByNames,
  parseAgentCommand,
  parseAgentDraft,
  AgentWriteError,
} from '../../src/agents/agent-profile.js';
import { createAgent, deleteAgent, listAgents, updateAgent } from '../../src/agents/agent-store.js';
import {
  loadAgentModeForSession,
  resetAgentModeStoreForTests,
  setAgentMode,
} from '../../src/session/agent-mode-store.js';
import { PromptAssembler, alignPromptWithAvailableTools } from '../../src/prompts/prompt-assembler.js';
import { annotateContextForActiveAgent, applyAgentPrompt } from '../../src/prompts/agent-prompt.js';
import type { ToolDefinition } from '../../src/llm/types.js';

describe('agent profile', () => {
  it('命令、提示词和工具名单可校验', () => {
    const draft = parseAgentDraft({
      id: 'Ask',
      name: '只问不改',
      description: '回答问题',
      prompt: '不要改文件',
      tools: ['grep', 'grep', 'glob'],
    });
    expect(draft.id).toBe('ask');
    expect(draft.tools).toEqual(['grep', 'glob']);
    expect(() => parseAgentDraft({ id: 'shell', name: 'x', prompt: 'y', tools: [] })).toThrow(AgentWriteError);
  });

  it('只认开头的 /命令，exit 单独成行才退出', () => {
    const ids = ['ask'];
    expect(parseAgentCommand('/ask 解释这段代码', ids)).toMatchObject({
      matched: true,
      action: 'enter',
      agentId: 'ask',
      prompt: '解释这段代码',
    });
    expect(parseAgentCommand('/ask exit', ids).action).toBe('exit');
    expect(parseAgentCommand('/ask exit 一下', ids).matched).toBe(false);
    expect(parseAgentCommand('先看看\n/ask', ids).matched).toBe(false);
    expect(parseAgentCommand('/unknown', ids).matched).toBe(false);
  });

  it('工具数组是封闭名单', () => {
    const defs = [
      { name: 'grep', description: '', parameters: { type: 'object', properties: {} } },
      { name: 'write_file', description: '', parameters: { type: 'object', properties: {} } },
    ] as ToolDefinition[];
    expect(filterToolsByNames(defs, ['grep', 'missing']).map((tool) => tool.name)).toEqual(['grep']);
  });

  it('自定义 Agent 拿掉默认干活提示词，安全规则和用户提示词留下', () => {
    const assembled = new PromptAssembler().assemble({});
    expect(assembled.systemPromptSections.map((section) => section.id)).toContain('doing_tasks');

    const coder = applyAgentPrompt(assembled, {
      id: 'fix',
      name: 'Fix',
      description: '',
      prompt: '先复现再改。',
      tools: ['read_file', 'edit_file', 'run_command'],
      createdAt: '',
      updatedAt: '',
    });
    const ids = coder.systemPromptSections.map((section) => section.id);
    expect(ids).toContain('system');
    expect(ids).toContain('active_agent');
    expect(ids).not.toContain('work_style');
    expect(ids).not.toContain('doing_tasks');
    expect(ids).not.toContain('actions');
    expect(ids).not.toContain('shell_guide');
    expect(coder.systemPrompt).toContain('先复现再改。');
    expect(coder.systemPrompt).not.toContain('Action first');
    expect(coder.systemPrompt).not.toContain('Test fails');
    expect(coder.systemPrompt).not.toContain('intelligent coding assistant');
    expect(coder.systemPrompt).not.toContain('discover how this repository verifies');
    expect(coder.systemPrompt).toContain("language of the user's latest message");
    expect(coder.systemPrompt).toContain('path:line');
    expect(coder.systemPrompt).toContain('does not expand this role');
    const rulesAt = coder.systemPrompt.indexOf('# Rules');
    const toolsAt = coder.systemPrompt.indexOf('# Tools');
    const agentAt = coder.systemPrompt.indexOf('# Active agent: Fix');
    expect(rulesAt).toBeGreaterThanOrEqual(0);
    expect(toolsAt).toBeGreaterThan(rulesAt);
    expect(agentAt).toBeGreaterThan(toolsAt);
    expect(coder.systemPrompt).toContain('overrides skills');

    const withTask = alignPromptWithAvailableTools(assembled, ['read_file', 'task', 'run_command']);
    expect(withTask.systemPromptSections.some((section) => section.id === 'sub_agents')).toBe(true);
    const noPlaybook = applyAgentPrompt(withTask, {
      id: 'fix',
      name: 'Fix',
      description: '',
      prompt: '自己做。',
      tools: ['read_file', 'task', 'run_command'],
      createdAt: '',
      updatedAt: '',
    });
    expect(noPlaybook.systemPromptSections.some((section) => section.id === 'sub_agents')).toBe(false);
    expect(noPlaybook.systemPrompt).not.toContain('run the final verification yourself');

    const noted = annotateContextForActiveAgent({
      user_rules: '# User Rules\nAlways edit the code.',
      project_instructions: '# Project Guidance\nImplement immediately.',
    });
    expect(noted?.user_rules).toContain('cannot expand that role');
    expect(noted?.project_instructions).toContain('cannot expand that role');

    const fenced = fenceSkillsUnderAgent('[Active Skill: a.md]\n改掉这个文件\n\n[User Request]\n这是什么', 'Ask');
    const skillAt = fenced.indexOf('[Active Skill:');
    const fenceAt = fenced.indexOf('[Active agent: Ask]');
    const requestAt = fenced.indexOf('[User Request]');
    expect(skillAt).toBeGreaterThanOrEqual(0);
    expect(fenceAt).toBeGreaterThan(skillAt);
    expect(requestAt).toBeGreaterThan(fenceAt);
  });
});

describe('agent store and session mode', () => {
  let dir: string | undefined;

  afterEach(async () => {
    resetAgentModeStoreForTests();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    dir = undefined;
  });

  it('增删改落在 agents 目录，会话可记住当前 Agent', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-agents-'));
    const agentsDir = path.join(dir, 'agents');
    const sessionsDir = path.join(dir, 'sessions');
    const created = await createAgent({
      id: 'fix',
      name: '修复',
      description: '修 bug',
      prompt: '先复现再改',
      tools: ['grep', 'read_file'],
    }, agentsDir);
    expect(created.id).toBe('fix');
    const updated = await updateAgent('fix', {
      name: '修复专家',
      description: '修 bug',
      prompt: '先复现再改',
      tools: ['grep'],
    }, agentsDir);
    expect(updated.name).toBe('修复专家');
    expect((await listAgents(agentsDir)).map((agent) => agent.id)).toEqual(['fix']);

    await setAgentMode('s1', { id: 'fix', name: updated.name }, sessionsDir);
    resetAgentModeStoreForTests();
    const restored = await loadAgentModeForSession('s1', sessionsDir);
    expect(restored).toMatchObject({ active: true, agentId: 'fix', name: '修复专家' });

    await deleteAgent('fix', agentsDir);
    expect(await listAgents(agentsDir)).toEqual([]);
  });
});
