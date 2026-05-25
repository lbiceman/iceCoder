import { describe, expect, it } from 'vitest';

import {
  buildVerificationDigest,
  isVerificationCommand,
  parseVitestFailureDigest,
} from '../../src/harness/verification-digest.js';

describe('verification-digest', () => {
  it('detects npm test / vitest commands', () => {
    expect(isVerificationCommand('npm test')).toBe(true);
    expect(isVerificationCommand('npm test -- test/unit/tasks.test.ts')).toBe(true);
    expect(isVerificationCommand('npx vitest run')).toBe(true);
    expect(isVerificationCommand('npm run build')).toBe(false);
  });

  it('parses vitest FAIL headers and assertions', () => {
    const output = [
      'FAIL test/unit/tasks.test.ts > random tasks > completes kill_count',
      'AssertionError: expected undefined to be kill_count',
      'Expected: "kill_count"',
      'Received: undefined',
    ].join('\n');
    const digest = parseVitestFailureDigest(output);
    expect(digest).toContain('[Verification digest]');
    expect(digest).toMatch(/FAIL test\/unit\/tasks/);
    expect(digest).toMatch(/AssertionError/);
  });

  it('buildVerificationDigest adds next-step hint', () => {
    const digest = buildVerificationDigest(
      'npm test -- test/unit/tasks.test.ts',
      'FAIL test/unit/tasks.test.ts\nAssertionError: expected true to be false',
    );
    expect(digest).toMatch(/read_file the failing test/);
    expect(digest).toContain('npm test');
  });
});
