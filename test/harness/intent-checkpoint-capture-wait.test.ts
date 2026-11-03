import { describe, expect, it } from 'vitest';

import {
  trackIntentCheckpointCapture,
  waitForIntentCheckpointCapture,
} from '../../src/harness/intent-checkpoint-capture.js';

describe('intent checkpoint capture wait', () => {
  it('lets later waiters observe the in-flight capture', async () => {
    let done = false;
    const work = new Promise<void>((resolve) => {
      setTimeout(() => {
        done = true;
        resolve();
      }, 20);
    });
    trackIntentCheckpointCapture('sess-wait', work);
    expect(done).toBe(false);
    await waitForIntentCheckpointCapture('sess-wait');
    expect(done).toBe(true);
    await waitForIntentCheckpointCapture('sess-wait');
  });
});
