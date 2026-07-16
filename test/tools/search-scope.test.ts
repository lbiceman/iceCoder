import { describe, expect, it, beforeAll } from 'vitest';
import { createSearchTools } from '../../src/tools/builtin/search-tools.js';
import { resolveRipgrepPath } from '../../src/tools/builtin/ripgrep-runner.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('search path scope', () => {
  let rgAvailable = false;

  beforeAll(async () => {
    rgAvailable = !!(await resolveRipgrepPath());
  });

  it('allows grep path outside workDir', async () => {
    const externalDir = mkdtempSync(path.join(tmpdir(), 'ice-search-scope-'));
    const externalFile = path.join(externalDir, 'outside-workdir.txt');
    writeFileSync(externalFile, 'outside-scope-probe', 'utf8');
    try {
      const grepTool = createSearchTools(repoRoot).find((t) => t.definition.name === 'grep')!;
      const result = await grepTool.handler({
        pattern: 'outside-scope-probe',
        path: externalFile,
      });
      expect(result.success).toBe(true);
      expect(result.error ?? '').not.toMatch(/within the work directory/i);
      expect(result.output).toContain('outside-workdir.txt');
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('glob finds files under workDir', async () => {
    if (!rgAvailable) return;
    const globTool = createSearchTools(repoRoot).find((t) => t.definition.name === 'glob')!;
    const result = await globTool.handler({
      pattern: 'package.json',
      path: '.',
      maxResults: 5,
    });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/package\.json/);
  });
});
