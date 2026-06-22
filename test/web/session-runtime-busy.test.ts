import { describe, expect, it, beforeEach } from 'vitest';

import {
  beginSessionHarnessRun,
  endSessionHarnessRun,
  resetHarnessRuntimeRegistry,
} from '../../src/harness/harness-runtime-registry.js';
import {
  canAcceptRuntimeRestore,
  registerSessionRuntimeBusyProbe,
  resetSessionRuntimeBusyProbe,
} from '../../src/web/session-runtime-busy.js';

describe('session-runtime-busy', () => {
  beforeEach(() => {
    resetHarnessRuntimeRegistry();
    resetSessionRuntimeBusyProbe();
  });

  it('blocks restore while harness run depth > 0', () => {
    beginSessionHarnessRun('s1');
    expect(canAcceptRuntimeRestore('s1')).toBe(false);
    endSessionHarnessRun('s1');
    expect(canAcceptRuntimeRestore('s1')).toBe(true);
  });

  it('blocks restore when runningTurn is processing', () => {
    registerSessionRuntimeBusyProbe({
      getRunningTurn: () => ({ isProcessing: true }),
    });
    expect(canAcceptRuntimeRestore('s1')).toBe(false);
  });

  it('blocks restore when pending batch count > 0', () => {
    registerSessionRuntimeBusyProbe({
      getPendingBatchCount: () => 2,
    });
    expect(canAcceptRuntimeRestore('s1')).toBe(false);
  });
});
