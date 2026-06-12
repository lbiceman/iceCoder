import { describe, expect, it, beforeAll } from 'vitest';
import { createSearchTools } from '../../src/tools/builtin/search-tools.js';
import { resolveRipgrepPath } from '../../src/tools/builtin/ripgrep-runner.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('glob/grep tools', () => {
  let rgAvailable = false;

  beforeAll(async () => {
    rgAvailable = !!(await resolveRipgrepPath());
  });

  it('glob finds TypeScript files', async () => {
    if (!rgAvailable) return;
    const [globTool] = createSearchTools(repoRoot).filter((t) => t.definition.name === 'glob');
    const result = await globTool.handler({ pattern: 'src/tools/builtin/search-tools.ts' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/search-tools\.ts/);
  });

  it('grep files_with_matches returns paths without huge bodies', async () => {
    if (!rgAvailable) return;
    const grepTool = createSearchTools(repoRoot).find((t) => t.definition.name === 'grep')!;
    const result = await grepTool.handler({
      pattern: 'createSearchTools',
      path: 'src/tools',
      output_mode: 'files_with_matches',
      maxResults: 10,
    });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(8_000);
    expect(result.output).toMatch(/search-tools/);
  });

  it('grep content mode respects max output budget', async () => {
    if (!rgAvailable) return;
    const grepTool = createSearchTools(repoRoot).find((t) => t.definition.name === 'grep')!;
    const result = await grepTool.handler({
      pattern: 'export',
      path: 'src/tools/builtin',
      output_mode: 'content',
      maxResults: 5,
    });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(30_000);
  });
});
