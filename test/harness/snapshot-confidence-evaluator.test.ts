import { describe, expect, it } from 'vitest';

import { SnapshotConfidenceEvaluator } from '../../src/harness/supervisor/snapshot-confidence-evaluator.js';
import type {
  SnapshotConfidenceConfig,
  SnapshotConfidenceInput,
  WorkspaceSnapshot,
} from '../../src/types/supervisor.js';

const DEFAULT_CONFIG: SnapshotConfidenceConfig = { templateGraphMin: 0.65 };

function makeSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    snapshotId: 'snap-test',
    at: 0,
    gitSummary: 'clean',
    filesAdded: [],
    filesModified: [],
    filesDeleted: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<SnapshotConfidenceInput> = {}): SnapshotConfidenceInput {
  return {
    snapshot: makeSnapshot(),
    repoFilesChanged: [],
    roundsSinceExtract: 0,
    lastVerifyPassed: false,
    ...overrides,
  };
}

describe('SnapshotConfidenceEvaluator - factors', () => {
  it('clean repo + fresh snapshot + verify passed yields high confidence (>=0.85)', () => {
    const evaluator = new SnapshotConfidenceEvaluator(DEFAULT_CONFIG);
    const result = evaluator.evaluate(
      makeInput({
        snapshot: makeSnapshot({
          gitSummary: 'clean',
          testSummary: 'passed',
          buildSummary: 'build passed',
        }),
        repoFilesChanged: [],
        roundsSinceExtract: 0,
        lastVerifyPassed: true,
      }),
    );

    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.meetsTemplateGraphThreshold).toBe(true);
    expect(result.factors).toMatchObject({
      gitClean: 1,
      snapshotAge: 1,
      verifyPassed: 1,
    });
  });

  it('aged snapshot >=5 rounds drops to 0 on snapshotAge factor', () => {
    const evaluator = new SnapshotConfidenceEvaluator(DEFAULT_CONFIG);
    const result = evaluator.evaluate(
      makeInput({
        roundsSinceExtract: 5,
        lastVerifyPassed: true,
      }),
    );
    expect(result.factors.snapshotAge).toBe(0);
  });

  it('large changed set lowers gitClean factor below threshold', () => {
    const evaluator = new SnapshotConfidenceEvaluator(DEFAULT_CONFIG);
    const result = evaluator.evaluate(
      makeInput({
        snapshot: makeSnapshot({
          gitSummary: 'M:12',
          filesModified: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`),
        }),
      }),
    );
    expect(result.factors.gitClean).toBeLessThanOrEqual(0.3);
    expect(result.meetsTemplateGraphThreshold).toBe(false);
  });

  it('repoContextMatch is the ratio of overlapping files', () => {
    const evaluator = new SnapshotConfidenceEvaluator(DEFAULT_CONFIG);
    const result = evaluator.evaluate(
      makeInput({
        snapshot: makeSnapshot({
          filesModified: ['src/a.ts', 'src/b.ts'],
        }),
        repoFilesChanged: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      }),
    );
    expect(result.factors.repoContextMatch).toBeCloseTo(0.5, 5);
  });

  it('test failed kills buildSignal factor', () => {
    const evaluator = new SnapshotConfidenceEvaluator(DEFAULT_CONFIG);
    const result = evaluator.evaluate(
      makeInput({
        snapshot: makeSnapshot({ testSummary: 'failed' }),
      }),
    );
    expect(result.factors.buildSignal).toBe(0);
    expect(result.factors.verifyPassed).toBe(0);
  });

  it('templateGraphMin gate flips when confidence is below configured threshold', () => {
    const evaluator = new SnapshotConfidenceEvaluator({ templateGraphMin: 0.95 });
    const result = evaluator.evaluate(
      makeInput({
        roundsSinceExtract: 0,
        lastVerifyPassed: true,
        snapshot: makeSnapshot({ testSummary: 'passed' }),
      }),
    );
    expect(result.confidence).toBeLessThan(0.95);
    expect(result.meetsTemplateGraphThreshold).toBe(false);
  });
});
