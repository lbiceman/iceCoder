import { describe, expect, it } from 'vitest';

import {
  buildVerificationDigest,
  isBuildVerificationCommand,
  isHarnessVerificationCommand,
  isVerificationCommand,
  parseBuildFailureDigest,
  parseBuildErrorSourcePaths,
  parseVitestFailureDigest,
} from '../../src/harness/verification-digest.js';

describe('verification-digest', () => {
  it('detects npm test / vitest / build commands', () => {
    expect(isHarnessVerificationCommand('npm test')).toBe(true);
    expect(isHarnessVerificationCommand('npm test -- test/unit/tasks.test.ts')).toBe(true);
    expect(isHarnessVerificationCommand('npx vitest run')).toBe(true);
    expect(isHarnessVerificationCommand('npm run build')).toBe(true);
    expect(isHarnessVerificationCommand('npm run test:e2e')).toBe(true);
    expect(isHarnessVerificationCommand('npx tsc --noEmit')).toBe(true);
    expect(isVerificationCommand('npm run build')).toBe(true);
    expect(isBuildVerificationCommand('npm run build 2>&1')).toBe(true);
    expect(isHarnessVerificationCommand('echo hello')).toBe(false);
    expect(isHarnessVerificationCommand('echo test')).toBe(false);
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

  it('parses tsc / vite build errors', () => {
    const output = [
      'src/scenes/MapSelectScene.ts(42,5): error TS1005: \'}\' expected.',
      'error during build:',
      'Rollup failed to resolve import',
    ].join('\n');
    const digest = parseBuildFailureDigest(output);
    expect(digest).toContain('[Build digest]');
    expect(digest).toMatch(/error TS1005/);
    expect(parseBuildErrorSourcePaths(output)).toContain('src/scenes/MapSelectScene.ts');
  });

  it('buildVerificationDigest adds next-step hint for tests and build', () => {
    const testDigest = buildVerificationDigest(
      'npm test -- test/unit/tasks.test.ts',
      'FAIL test/unit/tasks.test.ts\nAssertionError: expected true to be false',
    );
    expect(testDigest).toMatch(/read_file the failing test/);

    const buildDigest = buildVerificationDigest(
      'npm run build 2>&1',
      'src/foo.ts(1,1): error TS2304: Cannot find name \'Phaser\'.',
    );
    expect(buildDigest).toMatch(/npx tsc --noEmit/);
    expect(buildDigest).toContain('npm run build');
  });
});
