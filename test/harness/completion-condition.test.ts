import { describe, expect, it } from 'vitest';

import {
  CompletionConditionLedger,
  type CompletionCondition,
} from '../../src/harness/completion-condition.js';

function condition(overrides: Partial<CompletionCondition> = {}): CompletionCondition {
  return {
    id: 'condition:1',
    label: 'Original requirement',
    required: true,
    status: 'pending',
    source: 'user',
    sourceRef: 'user:1',
    evidenceRefs: [],
    ...overrides,
  };
}

describe('CompletionConditionLedger', () => {
  it('does not silently downgrade or rewrite a required condition', () => {
    const ledger = new CompletionConditionLedger();
    ledger.record(condition());
    ledger.record(condition({
      label: 'Rewritten',
      required: false,
      source: 'runtime',
      sourceRef: 'runtime:1',
    }));

    expect(ledger.list()).toEqual([
      expect.objectContaining({
        label: 'Original requirement',
        required: true,
        source: 'user',
        sourceRef: 'user:1',
      }),
    ]);
  });

  it('keeps required conditions when a source refresh omits them', () => {
    const ledger = new CompletionConditionLedger();
    ledger.record(condition());
    ledger.replaceSource('user', []);

    expect(ledger.list()).toHaveLength(1);
  });
});
