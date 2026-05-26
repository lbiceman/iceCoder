import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFileTools } from '../../src/tools/builtin/file-tools.js';

describe('write_file size limits', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'ice-write-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('rejects payloads over block char limit', async () => {
    const tools = createFileTools(workDir);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;
    const huge = 'x'.repeat(25_000);
    const result = await writeTool.handler({ path: 'big.ts', content: huge });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
  });

  it('warns on large but allowed payloads', async () => {
    const tools = createFileTools(workDir);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;
    const content = 'line\n'.repeat(160);
    const result = await writeTool.handler({ path: 'med.ts', content });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Warning: large payload/i);
  });
});
