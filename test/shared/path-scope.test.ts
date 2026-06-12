import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRipgrepSearchScope } from '../../src/shared/path-scope.js';
import { createSearchTools } from '../../src/tools/builtin/search-tools.js';
import { resolveRipgrepPath } from '../../src/tools/builtin/ripgrep-runner.js';

describe('resolveRipgrepSearchScope', () => {
  it('uses parent directory when path points to a file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-scope-'));
    try {
      const filePath = path.join(tmp, 'target.ts');
      await fs.writeFile(filePath, 'export const needle = 1;\n', 'utf-8');
      const scope = await resolveRipgrepSearchScope(tmp, 'target.ts');
      expect(scope.ok).toBe(true);
      if (!scope.ok) return;
      expect(scope.cwd).toBe(tmp);
      expect(scope.rgTarget).toBe('target.ts');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('grep on single file path', () => {
  it('finds matches when path is a file', async () => {
    if (!(await resolveRipgrepPath())) return;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-grep-file-'));
    try {
      await fs.writeFile(path.join(tmp, 'only.ts'), 'const needle = 42;\n', 'utf-8');
      const grepTool = createSearchTools(tmp).find((t) => t.definition.name === 'grep')!;
      const result = await grepTool.handler({
        pattern: 'needle',
        path: 'only.ts',
        output_mode: 'files_with_matches',
      });
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/only\.ts/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
