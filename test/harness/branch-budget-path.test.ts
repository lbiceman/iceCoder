import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import {
  canonicalBudgetPath,
  mergeBudgetPathMap,
} from '../../src/harness/branch-budget-path.js';

describe('branch-budget-path', () => {
  it('canonicalBudgetPath normalizes absolute paths under workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-budget-path-'));
    const abs = join(root, 'src', 'scenes', 'ShopScene.ts');
    mkdirSync(join(root, 'src', 'scenes'), { recursive: true });
    writeFileSync(abs, 'export {};\n');

    expect(canonicalBudgetPath(root, abs)).toBe('src/scenes/ShopScene.ts');
    expect(canonicalBudgetPath(root, 'src/scenes/ShopScene.ts')).toBe('src/scenes/ShopScene.ts');
  });

  it('bindWorkspaceRoot merges absolute and relative edit counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-budget-merge-'));
    const abs = join(root, 'src', 'a.ts');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(abs, 'x');

    const t = new BranchBudgetTracker({ fileEditMax: 3 });
    t.recordFileEdit('src/a.ts');
    t.recordFileEdit('src/a.ts');
    t.bindWorkspaceRoot(root);
    t.recordFileEdit(abs);

    expect(t.inspect().fileEdits['src/a.ts']).toBe(3);
    expect(t.wouldBlockFileEdit('src/a.ts')).toBe(true);
    expect(t.wouldBlockFileEdit(abs)).toBe(true);
  });

  it('mergeBudgetPathMap keeps max count per canonical key', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-budget-map-'));
    const merged = mergeBudgetPathMap(
      new Map([
        ['src/a.ts', 2],
        [join(root, 'src', 'a.ts'), 3],
      ]),
      root,
    );
    expect(merged.get('src/a.ts')).toBe(3);
  });
});
