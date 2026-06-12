import { describe, expect, it } from 'vitest';

import { decideGraphHintRouting } from '../../src/harness/supervisor/graph-hint-routing.js';

describe('Free-mode graph hint routing - Batch 5 / W2', () => {
  it('drops graph evaluateRound message when execution mode is free', () => {
    const decision = decideGraphHintRouting({
      executionMode: 'free',
      action: 'force_switch',
      message: '[Graph] retry on fallback',
    });

    expect(decision.injectToCorrectionPort).toBe(false);
    expect(decision.emitTelemetry).toBe(true);
  });

  it('keeps the message routed through CorrectionPort under forced mode', () => {
    const decision = decideGraphHintRouting({
      executionMode: 'forced',
      action: 'force_switch',
      message: '[Graph] retry on fallback',
    });

    expect(decision.injectToCorrectionPort).toBe(true);
    expect(decision.emitTelemetry).toBe(true);
  });

  it('drops nothing when there is no message', () => {
    const decision = decideGraphHintRouting({
      executionMode: 'forced',
      action: 'inject_hint',
      message: undefined,
    });

    expect(decision.injectToCorrectionPort).toBe(false);
    expect(decision.emitTelemetry).toBe(false);
  });
});
