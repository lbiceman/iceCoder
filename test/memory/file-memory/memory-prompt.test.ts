import { describe, it, expect } from 'vitest';
import { buildMemoryInstructions } from '../../../src/memory/file-memory/memory-prompt.js';

describe('buildMemoryInstructions', () => {
  it('强调普通编码任务优先执行，不为维护记忆打断主任务', () => {
    const prompt = buildMemoryInstructions('/tmp/memory');

    expect(prompt).toContain('not as a replacement for the user');
    expect(prompt).toContain('only when the user explicitly asks');
    expect(prompt).toContain('focus on the task');
  });
});
