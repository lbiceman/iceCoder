import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { repairCoarseTopicSupersessions } from '../../../src/memory/file-memory/memory-false-merge-repair.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `false-merge-repair-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('repairCoarseTopicSupersessions', () => {
  it('恢复 lang: 误合并，不动真正的 preference 覆盖', async () => {
    await fs.writeFile(path.join(tempDir, 'victim.md'), `---
name: victim
description: 2D visibility
type: feedback
evidenceStrength: explicit
confidence: 0.1
superseded-by: keeper.md
superseded-topic: lang:csharp
superseded-at: 2026-09-18T08:21:07.468Z
---
body
`, 'utf-8');
    await fs.writeFile(path.join(tempDir, 'keeper.md'), `---
name: keeper
description: preprocessor
type: feedback
confidence: 0.85
preference-topic: lang:csharp
merged-from: ["victim.md", "related.md"]
---
keeper body
`, 'utf-8');
    await fs.writeFile(path.join(tempDir, 'real-old.md'), `---
name: real-old
description: concise
type: user
confidence: 0.45
superseded-by: real-new.md
superseded-topic: preference:response-style
---
old pref
`, 'utf-8');

    const result = await repairCoarseTopicSupersessions(tempDir);
    expect(result.restored).toEqual(['victim.md']);
    expect(result.keepersUpdated).toEqual(['keeper.md']);

    const victim = await fs.readFile(path.join(tempDir, 'victim.md'), 'utf-8');
    expect(victim).toContain('confidence: 0.85');
    expect(victim).not.toContain('superseded-by');

    const keeper = await fs.readFile(path.join(tempDir, 'keeper.md'), 'utf-8');
    expect(keeper).not.toContain('preference-topic: lang:csharp');
    expect(keeper).toContain('merged-from: ["related.md"]');

    const realOld = await fs.readFile(path.join(tempDir, 'real-old.md'), 'utf-8');
    expect(realOld).toContain('superseded-by: real-new.md');
    expect(realOld).toContain('confidence: 0.45');
  });
});
