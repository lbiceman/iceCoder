import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readTypeScriptSourceFiles } from './source-file-scan.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('source-file-scan', () => {
  it('returns normalized TypeScript paths without generated or worktree directories', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-source-scan-'));
    await Promise.all([
      fs.mkdir(path.join(tempDir, 'src', 'nested'), { recursive: true }),
      fs.mkdir(path.join(tempDir, 'src', 'node_modules'), { recursive: true }),
      fs.mkdir(path.join(tempDir, 'src', '.worktrees'), { recursive: true }),
      fs.mkdir(path.join(tempDir, 'src', 'dist'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(tempDir, 'src', 'nested', 'kept.ts'), 'export {};\n'),
      fs.writeFile(path.join(tempDir, 'src', 'nested', 'ignored.js'), 'export {};\n'),
      fs.writeFile(path.join(tempDir, 'src', 'node_modules', 'ignored.ts'), 'export {};\n'),
      fs.writeFile(path.join(tempDir, 'src', '.worktrees', 'ignored.ts'), 'export {};\n'),
      fs.writeFile(path.join(tempDir, 'src', 'dist', 'ignored.ts'), 'export {};\n'),
    ]);

    const files = await readTypeScriptSourceFiles(path.join(tempDir, 'src'), tempDir);

    expect(files.map(file => file.relativePath)).toEqual(['src/nested/kept.ts']);
    expect(files[0].content).toBe('export {};\n');
  });
});
