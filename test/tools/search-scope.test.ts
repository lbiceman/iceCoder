import { describe, expect, it, beforeAll } from 'vitest';
import { createSearchTools } from '../../src/tools/builtin/search-tools.js';
import { resolveRipgrepPath } from '../../src/tools/builtin/ripgrep-runner.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('search path scope', () => {
  let rgAvailable = false;

  beforeAll(async () => {
    rgAvailable = !!(await resolveRipgrepPath());
  });

  it('rejects grep path outside workDir', async () => {
    const grepTool = createSearchTools(repoRoot).find((t) => t.definition.name === 'grep')!;
    const result = await grepTool.handler({
      pattern: 'test',
      path: '..',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/within the work directory/i);
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
