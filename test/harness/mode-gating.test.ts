import { describe, expect, it } from 'vitest';
import { normalizeGraphHintInput } from '../../src/harness/supervisor/mode-gating.js';

describe('mode-gating normalizeGraphHintInput', () => {
  it('maps evaluate_round origin to evaluate_round reason tag', () => {
    expect(
      normalizeGraphHintInput({
        origin: 'evaluate_round',
        action: 'force_switch',
        message: '[Graph] fallback',
      }),
    ).toEqual({
      message: '[Graph] fallback',
      action: 'force_switch',
      reasonTag: 'evaluate_round',
    });
  });

  it('maps forced_step warn to inject_hint + forced_step_warn', () => {
    expect(
      normalizeGraphHintInput({
        origin: 'forced_step',
        kind: 'warn',
        message: '[Graph] warn',
      }),
    ).toEqual({
      message: '[Graph] warn',
      action: 'inject_hint',
      reasonTag: 'forced_step_warn',
    });
  });

  it('maps forced_step block to block + forced_step_block', () => {
    expect(
      normalizeGraphHintInput({
        origin: 'forced_step',
        kind: 'block',
        message: '[Graph] block',
      }),
    ).toEqual({
      message: '[Graph] block',
      action: 'block',
      reasonTag: 'forced_step_block',
    });
  });
});
