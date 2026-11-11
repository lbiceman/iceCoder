import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPatchTool } from '../../src/tools/builtin/patch-tool.js';
import { markFileRead } from '../../src/tools/read-before-edit.js';

describe('patch_file unmatched context', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('returns the expected lines and the nearby file text when every hunk misses', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ice-patch-'));
    const file = path.join(dir, 'a.ts');
    await writeFile(file, 'export const value = 1;\n', 'utf8');
    markFileRead(dir, 'a.ts', 'default');

    const result = await createPatchTool(dir).handler({
      path: 'a.ts',
      patch: [
        '@@ -1,1 +1,1 @@',
        '-export const missing = 0;',
        '+export const value = 2;',
        '',
      ].join('\n'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('未匹配的上下文');
    expect(result.error).toContain('export const missing = 0;');
    expect(result.error).toContain('export const value = 1;');
    expect(await readFile(file, 'utf8')).toBe('export const value = 1;\n');
  });
});
