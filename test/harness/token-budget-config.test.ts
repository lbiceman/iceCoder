import { afterEach, describe, expect, it } from 'vitest';

import {
  getMaxSegmentRenewals,
  isSoftCheckpointEnabled,
} from '../../src/harness/token-budget-config.js';

describe('token-budget-config · segment renewal env', () => {
  const origSoft = process.env.ICE_HARNESS_SOFT_CHECKPOINT;
  const origMax = process.env.ICE_HARNESS_MAX_SEGMENT_RENEWALS;

  afterEach(() => {
    if (origSoft === undefined) delete process.env.ICE_HARNESS_SOFT_CHECKPOINT;
    else process.env.ICE_HARNESS_SOFT_CHECKPOINT = origSoft;
    if (origMax === undefined) delete process.env.ICE_HARNESS_MAX_SEGMENT_RENEWALS;
    else process.env.ICE_HARNESS_MAX_SEGMENT_RENEWALS = origMax;
  });

  it('isSoftCheckpointEnabled defaults to true', () => {
    delete process.env.ICE_HARNESS_SOFT_CHECKPOINT;
    expect(isSoftCheckpointEnabled()).toBe(true);
  });

  it('isSoftCheckpointEnabled respects ICE_HARNESS_SOFT_CHECKPOINT=0', () => {
    process.env.ICE_HARNESS_SOFT_CHECKPOINT = '0';
    expect(isSoftCheckpointEnabled()).toBe(false);
  });

  it('getMaxSegmentRenewals defaults to 20', () => {
    delete process.env.ICE_HARNESS_MAX_SEGMENT_RENEWALS;
    expect(getMaxSegmentRenewals()).toBe(20);
  });

  it('getMaxSegmentRenewals reads ICE_HARNESS_MAX_SEGMENT_RENEWALS', () => {
    process.env.ICE_HARNESS_MAX_SEGMENT_RENEWALS = '3';
    expect(getMaxSegmentRenewals()).toBe(3);
  });
});
