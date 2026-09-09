import { describe, expect, it } from 'vitest';
import { assemblePlanModePrompt } from '../../src/prompts/plan-mode-prompt.js';
import { PLAN_MODE_REMOVED_SECTION_IDS } from '../../src/prompts/sections.js';
import type { AssembledPrompt } from '../../src/prompts/types.js';

describe('assemblePlanModePrompt', () => {
  it('injects plan_mode and drops implementation sections', () => {
    const assembled = {
      systemPrompt: 'base',
      systemPromptSections: [
        { id: 'intro', title: 'Identity', content: 'You are iceCoder.', isStatic: true, priority: 0, enabled: true },
        { id: 'doing_tasks', title: 'Execution', content: 'Modify files.', isStatic: true, priority: 20, enabled: true },
        { id: 'actions', title: 'Confirm', content: 'Prefer edit.', isStatic: true, priority: 30, enabled: true },
        { id: 'tool_usage', title: 'Tools', content: 'Use write_file and run_command.', isStatic: true, priority: 40, enabled: true },
        { id: 'shell_guide', title: 'Shell', content: 'Use shell.', isStatic: true, priority: 45, enabled: true },
      ],
    } as AssembledPrompt;

    const overlaid = assemblePlanModePrompt(assembled);
    const ids = overlaid.systemPromptSections.map((s) => s.id);
    expect(ids).toContain('plan_mode');
    for (const removed of PLAN_MODE_REMOVED_SECTION_IDS) {
      expect(ids).not.toContain(removed);
    }
    expect(overlaid.systemPrompt).toContain('Plan Mode (active)');
    expect(overlaid.systemPrompt).not.toContain('Modify files.');
    expect(overlaid.systemPrompt).not.toContain('write_file');
  });
});
