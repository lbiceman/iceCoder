import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LEGACY_FIELDS = /\b(?:verificationStatus|verificationRequired|verificationPending|acceptanceGate)\b/;
const ALLOWED_SOURCE_FILES = new Set([
  'src/harness/legacy-checkpoint-adapter.ts',
  'src/harness/checkpoint-engine.ts',
  'src/types/legacy-runtime-schema.ts',
  'src/types/runtime-checkpoint.ts',
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  }));
  return nested.flat();
}

describe('legacy verification field architecture', () => {
  it('keeps legacy fields outside the new runtime', async () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const file of await sourceFiles(path.join(root, 'src'))) {
      const relative = path.relative(root, file).replace(/\\/g, '/');
      if (ALLOWED_SOURCE_FILES.has(relative)) continue;
      if (LEGACY_FIELDS.test(await fs.readFile(file, 'utf-8'))) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
