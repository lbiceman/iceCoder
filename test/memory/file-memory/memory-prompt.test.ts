import { describe, it, expect } from 'vitest';
import {
  buildMemoryInstructions,
  buildReadOnlyMemoryInstructions,
} from '../../../src/memory/file-memory/memory-prompt.js';

describe('buildMemoryInstructions', () => {
  it('强调普通编码任务优先执行，不为维护记忆打断主任务', () => {
    const prompt = buildMemoryInstructions('/tmp/memory');

    expect(prompt).toContain('not as a replacement for the user');
    expect(prompt).toContain('unless the user explicitly asks you to remember');
    expect(prompt).toContain('session-notes');
    expect(prompt).toContain('focus on the task');
  });

  it('无工具模式只提供只读记忆说明', () => {
    const prompt = buildReadOnlyMemoryInstructions();
    expect(prompt).toContain('read-only background context');
    expect(prompt).toContain('Do not attempt to read, write, update, or delete memory files');
    expect(prompt).not.toContain('How to Save');
  });
});
