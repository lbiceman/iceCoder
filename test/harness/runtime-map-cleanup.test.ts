import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discardPreCommandInventories,
  getWorkspaceInventoryDiagnostics,
  PRE_COMMAND_INVENTORY_LIMIT,
  rememberPreCommandInventory,
  takePreCommandInventory,
  type WorkspaceFileInventory,
} from '../../src/harness/workspace-command-touch.js';
import {
  getCheckpointIndexLockCount,
  touchSessionTouchedPaths,
} from '../../src/harness/intent-checkpoint-store.js';
import {
  hasProjectCheckpointWriteState,
  ProjectCheckpointStore,
  releaseProjectCheckpointWriteState,
} from '../../src/harness/project-checkpoint-store.js';

function inventory(): WorkspaceFileInventory {
  return Object.assign(new Map(), { complete: true }) as WorkspaceFileInventory;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-map-cleanup-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('pre-command workspace inventories', () => {
  it('discards snapshots that were never taken (aborted tool calls)', () => {
    const before = getWorkspaceInventoryDiagnostics().preCommandInventorySize;
    rememberPreCommandInventory('s-abort', 'tc-1', inventory());
    rememberPreCommandInventory('s-abort', 'tc-2', inventory());
    expect(getWorkspaceInventoryDiagnostics().preCommandInventorySize).toBe(before + 2);
    discardPreCommandInventories('s-abort', ['tc-1', 'tc-2']);
    expect(getWorkspaceInventoryDiagnostics().preCommandInventorySize).toBe(before);
    expect(takePreCommandInventory('s-abort', 'tc-1')).toBeUndefined();
  });

  it('caps untaken snapshots and evicts the oldest first', () => {
    for (let i = 0; i < PRE_COMMAND_INVENTORY_LIMIT + 10; i++) {
      rememberPreCommandInventory('s-cap', `tc-${i}`, inventory());
    }
    expect(getWorkspaceInventoryDiagnostics().preCommandInventorySize).toBeLessThanOrEqual(PRE_COMMAND_INVENTORY_LIMIT);
    expect(takePreCommandInventory('s-cap', 'tc-0')).toBeUndefined();
    expect(takePreCommandInventory('s-cap', `tc-${PRE_COMMAND_INVENTORY_LIMIT + 9}`)).toBeDefined();
    discardPreCommandInventories(
      's-cap',
      Array.from({ length: PRE_COMMAND_INVENTORY_LIMIT + 10 }, (_, i) => `tc-${i}`),
    );
  });
});

describe('checkpoint index write locks', () => {
  it('drops the per-session chain once writes settle', async () => {
    const before = getCheckpointIndexLockCount();
    await Promise.all([
      touchSessionTouchedPaths(tempDir, 'lock-a', ['a.ts']),
      touchSessionTouchedPaths(tempDir, 'lock-a', ['b.ts']),
      touchSessionTouchedPaths(tempDir, 'lock-b', ['c.ts']),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(getCheckpointIndexLockCount()).toBe(before);
  });
});

describe('project checkpoint write state', () => {
  it('is released for a deleted session after pending work drains', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'gone' });
    const loading = store.load();
    expect(hasProjectCheckpointWriteState(tempDir, 'gone')).toBe(true);
    releaseProjectCheckpointWriteState(tempDir, 'gone');
    expect(hasProjectCheckpointWriteState(tempDir, 'gone')).toBe(true);
    await loading;
    await new Promise((r) => setTimeout(r, 0));
    expect(hasProjectCheckpointWriteState(tempDir, 'gone')).toBe(false);
  });

  it('ignores sessions without cached state', () => {
    expect(() => releaseProjectCheckpointWriteState(tempDir, 'never-used')).not.toThrow();
  });
});
