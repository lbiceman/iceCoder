import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('graph terminal stop', () => {
  it('does not let Harness short-circuit graph completion before the final LLM body', () => {
    const source = readFileSync(
      new URL('../../src/harness/harness.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('tryGraphTerminalStop');
    expect(source).not.toContain('shouldBlockGraphTerminalStop');
  });
});
