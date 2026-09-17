import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { readTypeScriptSourceFiles } from './source-file-scan.js';

const LEGACY_FIELDS = /\b(?:verificationStatus|verificationRequired|verificationPending|acceptanceGate)\b/;
const ALLOWED_SOURCE_FILES = new Set([
  'src/harness/legacy-checkpoint-adapter.ts',
  'src/harness/checkpoint-engine.ts',
  'src/types/legacy-runtime-schema.ts',
  'src/types/runtime-checkpoint.ts',
]);

describe('legacy verification field architecture', () => {
  it('keeps legacy fields outside the new runtime', async () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const file of await readTypeScriptSourceFiles(path.join(root, 'src'), root)) {
      if (ALLOWED_SOURCE_FILES.has(file.relativePath)) continue;
      if (LEGACY_FIELDS.test(file.content)) offenders.push(file.relativePath);
    }
    expect(offenders).toEqual([]);
  });
});
