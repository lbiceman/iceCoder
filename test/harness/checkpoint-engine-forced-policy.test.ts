import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CheckpointEngine } from '../../src/harness/checkpoint-engine.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

async function makeSessionDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-engine-forced-'));
  tempDirs.push(dir);
  return dir;
}

describe('CheckpointEngine forced policy - Batch 5 / W1', () => {
  it('defaults to free policy and treats step_completed as eligible-to-skip', async () => {
    const engine = new CheckpointEngine(await makeSessionDir());
    expect(engine.isForcedPolicyActive()).toBe(false);
    expect(engine.shouldPersistOnTrigger('step_completed')).toBe(false);
    expect(engine.shouldPersistOnTrigger('tool_failed')).toBe(true);
  });

  it('persists on every step_completed once forced policy is active', async () => {
    const engine = new CheckpointEngine(await makeSessionDir());
    engine.setForcedPolicy(true);

    expect(engine.isForcedPolicyActive()).toBe(true);
    expect(engine.shouldPersistOnTrigger('step_completed')).toBe(true);
    expect(engine.shouldPersistOnTrigger('verification_started')).toBe(true);
  });

  it('falls back to free policy when forced policy is cleared', async () => {
    const engine = new CheckpointEngine(await makeSessionDir());
    engine.setForcedPolicy(true);
    engine.setForcedPolicy(false);

    expect(engine.isForcedPolicyActive()).toBe(false);
    expect(engine.shouldPersistOnTrigger('step_completed')).toBe(false);
  });
});
