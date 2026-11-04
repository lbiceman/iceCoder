import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDiagnosticsTool } from '../../src/tools/builtin/diagnostics-tool.js';

describe('diagnostics tool', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reports a TypeScript error as path:line', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ice-diag-'));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src'],
    }), 'utf8');
    await writeFile(path.join(dir, 'src', 'add.ts'), 'export const broken: number = "no";\n', 'utf8');

    const result = await createDiagnosticsTool(dir).handler({});
    expect(result.success).toBe(true);
    expect(result.output).toContain('src/add.ts:1:');
    expect(result.output).toContain('TS2322');
  });

  it('says when the workspace has no project diagnostics', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ice-diag-'));
    const result = await createDiagnosticsTool(dir).handler({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('tsconfig.json');
  });
});
