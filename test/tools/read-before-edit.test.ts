import { describe, it, expect } from 'vitest';
import { checkReadBeforeEdit, isSessionOrMemoryNotesPath } from '../../src/tools/read-before-edit.js';

describe('read-before-edit', () => {
  const workDir = 'D:/proj';

  it('session-notes 路径豁免 read-before-edit', () => {
    expect(isSessionOrMemoryNotesPath(workDir, 'data/session-notes.md')).toBe(true);
    expect(checkReadBeforeEdit(workDir, 'data/session-notes.md')).toBeNull();
  });

  it('长期记忆路径豁免 read-before-edit', () => {
    expect(checkReadBeforeEdit(workDir, 'data/user-memory/MEMORY.md')).toBeNull();
    expect(checkReadBeforeEdit(workDir, 'data/memory-files/MEMORY.md')).toBeNull();
  });

  it('普通源码仍要求先 read', () => {
    expect(checkReadBeforeEdit(workDir, 'src/foo.ts')).toMatch(/read-before-edit:/);
  });
});
