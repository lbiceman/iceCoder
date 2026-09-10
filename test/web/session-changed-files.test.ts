import { describe, expect, it } from 'vitest';
import { buildCheckpointChangedFiles } from '../../src/web/session-changed-files.js';

describe('buildCheckpointChangedFiles', () => {
  it('只输出 checkpoint 里的路径，并用 tool_trace 标注操作', () => {
    const files = buildCheckpointChangedFiles(
      ['notes/todo.md', 'src/foo.ts', 'docs/readme.md'],
      [
        { role: 'tool_trace', toolName: 'write_file', detail: 'notes/todo.md', status: 'success', sentAt: 20 },
        { role: 'tool_trace', toolName: 'read_file', detail: 'src/foo.ts', status: 'success', sentAt: 10 },
        { role: 'tool_trace', toolName: 'edit_file', detail: 'docs/readme.md', status: 'success', sentAt: 30 },
      ],
    );
    expect(files.map((f) => f.path)).toEqual(['docs/readme.md', 'notes/todo.md']);
    expect(files.find((f) => f.path === 'notes/todo.md')?.op).toBe('新建');
    expect(files.find((f) => f.path === 'docs/readme.md')?.op).toBe('修改');
  });

  it('没有 tool_trace 时仍展示 checkpoint 路径，不另造清单', () => {
    const files = buildCheckpointChangedFiles(['a/b.ts', 'a/b.ts', ''], []);
    expect(files).toEqual([{ path: 'a/b.ts', op: '修改', ts: 0 }]);
  });

  it('不会把路径名里的 delete 当成删除操作', () => {
    const files = buildCheckpointChangedFiles(
      ['src/delete-me.ts'],
      [{ role: 'tool_trace', toolName: 'write_file', detail: 'src/delete-me.ts', status: 'success', sentAt: 1 }],
    );
    expect(files[0]?.op).toBe('新建');
  });
});
