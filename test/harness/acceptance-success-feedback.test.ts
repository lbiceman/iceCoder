import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('legacy acceptance success feedback', () => {
  it('is absent from the production tool-round path', () => {
    const source = readFileSync(
      new URL('../../src/harness/harness-tool-round.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('[System / Completion ✓]');
    expect(source).not.toContain('buildAcceptanceSuccessFeedbackMessage');
  });
});
