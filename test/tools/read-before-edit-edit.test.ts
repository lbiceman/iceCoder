import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileTools } from '../../src/tools/builtin/file-tools.js';
import { clearReadBeforeEditScope } from '../../src/tools/read-before-edit.js';

describe('read-before-edit with edit_file', () => {
  let tmpDir: string;

  beforeEach(async () => {
    process.env.ICE_READ_BEFORE_EDIT = '1';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-rbe-'));
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello world\n', 'utf-8');
    clearReadBeforeEditScope(tmpDir, 'sess-a');
  });

  afterEach(async () => {
    delete process.env.ICE_READ_BEFORE_EDIT;
    clearReadBeforeEditScope(tmpDir, 'sess-a');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('blocks edit_file until read_file', async () => {
    const tools = createFileTools(tmpDir, 'sess-a');
    const edit = tools.find((t) => t.definition.name === 'edit_file')!;
    const read = tools.find((t) => t.definition.name === 'read_file')!;

    const blocked = await edit.handler({
      path: 'a.txt',
      search: 'hello',
      replace: 'hi',
    });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/read-before-edit/);

    await read.handler({ path: 'a.txt' });

    const ok = await edit.handler({
      path: 'a.txt',
      search: 'hello',
      replace: 'hi',
    });
    expect(ok.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf-8');
    expect(content).toBe('hi world\n');
  });

  it('blocks write_file overwrite until read', async () => {
    const tools = createFileTools(tmpDir, 'sess-a');
    const write = tools.find((t) => t.definition.name === 'write_file')!;

    const blocked = await write.handler({ path: 'a.txt', content: 'new\n' });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/read-before-edit/);
  });
});
