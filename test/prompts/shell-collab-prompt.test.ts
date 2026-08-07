import { describe, expect, it } from 'vitest';
import { PromptAssembler } from '../../src/prompts/prompt-assembler.js';
import {
  applyShellCollabPromptOverlay,
  loadShellCopilotSkillBody,
} from '../../src/prompts/shell-collab-prompt.js';
import {
  createShellCopilotSection,
  getDefaultSections,
  SHELL_COLLAB_REMOVED_SECTION_IDS,
} from '../../src/prompts/sections.js';

describe('shell-collab prompt (Wave 7.2)', () => {
  it('createShellCopilotSection 包含核心规则与 awaiting_input 停手', () => {
    const section = createShellCopilotSection();
    expect(section.id).toBe('shell_copilot');
    expect(section.content).toContain('Shell Copilot Mode (active)');
    expect(section.content).toContain('awaiting_input');
    expect(section.content).toContain('shell_exec');
    expect(section.content).toContain('Never use normal Agent tools');
  });

  it('applyShellCollabPromptOverlay 移除普通 Agent 工具说明', () => {
    const assembler = new PromptAssembler();
    const base = assembler.assemble({});
    const overlay = applyShellCollabPromptOverlay(base);

    expect(overlay.systemPrompt).toContain('Shell Copilot Mode (active)');
    expect(overlay.systemPrompt).not.toContain('run_command');
    expect(overlay.systemPrompt).not.toContain('parse_document');
    expect(overlay.systemPrompt).not.toContain('mcp_');
    expect(overlay.systemPrompt).not.toContain('read_file');
    expect(overlay.systemPrompt).not.toContain('request_analysis');

    const ids = overlay.systemPromptSections.map((s) => s.id);
    for (const removed of SHELL_COLLAB_REMOVED_SECTION_IDS) {
      expect(ids).not.toContain(removed);
    }
    expect(ids).toContain('shell_copilot');
    expect(ids).toContain('intro');
  });

  it('applyShellCollabPromptOverlay 保留传入的自定义 system 且不重新注入默认段落', () => {
    const assembler = new PromptAssembler();
    const base = assembler.assemble({
      customSystemPrompt: '# Team rules\nAlways preserve the deployment checklist.',
    });
    const overlay = applyShellCollabPromptOverlay(base);

    expect(overlay.systemPrompt).toContain('Always preserve the deployment checklist.');
    expect(overlay.systemPrompt).toContain('Shell Copilot Mode (active)');
    expect(overlay.systemPrompt).not.toContain('You are iceCoder');
    expect(overlay.systemPromptSections.map((section) => section.id)).toEqual([
      'custom',
      'shell_copilot',
    ]);
  });

  it('applyShellCollabPromptOverlay 过滤禁用段落并替换旧 shell section', () => {
    const assembler = new PromptAssembler();
    assembler.addSection({
      id: 'team_rules',
      title: 'Team rules',
      content: 'Keep the custom release policy.',
      isStatic: true,
      priority: 5,
      enabled: true,
    });
    assembler.addSection({
      id: 'disabled_custom',
      title: 'Disabled',
      content: 'This must not be included.',
      isStatic: true,
      priority: 6,
      enabled: false,
    });
    const firstOverlay = applyShellCollabPromptOverlay(assembler.assemble({}), 'old examples');
    const overlay = applyShellCollabPromptOverlay(firstOverlay, 'new examples');

    expect(overlay.systemPrompt).toContain('Keep the custom release policy.');
    expect(overlay.systemPrompt).not.toContain('This must not be included.');
    expect(overlay.systemPrompt).not.toContain('old examples');
    expect(overlay.systemPrompt).toContain('new examples');
    expect(overlay.systemPromptSections.filter((section) => section.id === 'shell_copilot')).toHaveLength(1);
  });

  it('loadShellCopilotSkillBody 可读 repo 内 shellCopilot/skill.md', async () => {
    const body = await loadShellCopilotSkillBody();
    expect(body).toBeTruthy();
    expect(body).toContain('SSH');
    expect(body).toContain('帮我执行');
    expect(body).toContain('awaiting_input');
  });

  it('getDefaultSections 仍含被 Shell 模式剔除的段落（普通会话不受影响）', () => {
    const defaults = getDefaultSections();
    expect(defaults.some((s) => s.id === 'tool_usage')).toBe(true);
    expect(defaults.some((s) => s.id === 'doing_tasks')).toBe(true);
  });
});
