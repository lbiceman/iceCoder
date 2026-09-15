import { describe, expect, it } from 'vitest';

import {
  buildVerificationDigest,
  buildVerificationSuccessSummary,
  parseBuildFailureDigest,
  parseBuildErrorSourcePaths,
  parseBuildSuccessSummary,
  parseNpmInstallSuccessSummary,
  parsePlaywrightSuccessSummary,
  parseVitestFailureDigest,
  parseVitestSuccessSummary,
  resolveVerificationSuccessSummary,
} from '../../src/harness/verification-digest.js';

describe('verification-digest', () => {
  it('builds a generic digest for any failed command including opaque scripts', () => {
    const digest = buildVerificationDigest('./scripts/ci.sh', 'FAIL ./scripts/ci.sh\nboom');
    expect(digest).toContain('./scripts/ci.sh');
    expect(digest).toContain('FAIL ./scripts/ci.sh');
    expect(buildVerificationDigest('npm test', 'FAIL x')).toContain('npm test');
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
    expect(testDigest).toMatch(/project's own verification command/);

    const buildDigest = buildVerificationDigest(
      'npm run build 2>&1',
      'src/foo.ts(1,1): error TS2304: Cannot find name \'Phaser\'.',
    );
    expect(buildDigest).toMatch(/project's own verification command/);
    expect(buildDigest).toContain('npm run build');
  });

  describe('success summary parsers', () => {
    it('parseVitestSuccessSummary returns files + tests passed', () => {
      const out = [
        '> spellbrigade-survivor-starter@0.0.1 test',
        '> vitest run',
        '',
        ' RUN  v2.1.9 E:/foo',
        '',
        ' Test Files  8 passed (8)',
        '      Tests  22 passed (22)',
        '   Start at  17:40:26',
        '   Duration  1.41s',
      ].join('\n');
      expect(parseVitestSuccessSummary(out)).toBe('8 files / 22 tests passed');
    });

    it('parseVitestSuccessSummary returns null on failed output', () => {
      const out = ' Test Files  1 failed (1)\n      Tests  1 failed (3)';
      expect(parseVitestSuccessSummary(out)).toBeNull();
    });

    it('parsePlaywrightSuccessSummary extracts passed count + duration', () => {
      const out = [
        'Running 5 tests using 1 worker',
        '  ✓ 1 [chromium] › test/e2e/boot.spec.ts:3:1 › loads game shell (365ms)',
        '  5 passed (4.4s)',
      ].join('\n');
      expect(parsePlaywrightSuccessSummary(out)).toBe('5 e2e tests passed in 4.4s');
    });

    it('parsePlaywrightSuccessSummary returns null when tests failed', () => {
      const out = '5 tests using 1 worker\n3 passed\n2 failed';
      expect(parsePlaywrightSuccessSummary(out)).toBeNull();
    });

    it('parseBuildSuccessSummary extracts vite `built in Xs`', () => {
      const out = [
        'vite v6.4.2 building for production...',
        'transforming...',
        '✓ 16 modules transformed.',
        '✓ built in 7.49s',
      ].join('\n');
      expect(parseBuildSuccessSummary(out)).toBe('build succeeded in 7.49s');
    });

    it('parseBuildSuccessSummary returns null on TS error', () => {
      const out = 'src/foo.ts(1,1): error TS2304: Cannot find name \'Phaser\'.';
      expect(parseBuildSuccessSummary(out)).toBeNull();
    });

    it('parseNpmInstallSuccessSummary extracts `added N packages in T`', () => {
      const out = 'added 60 packages in 4s\n15 packages are looking for funding';
      expect(parseNpmInstallSuccessSummary(out)).toBe('added 60 packages in 4s');
    });

    it('parseNpmInstallSuccessSummary returns null on npm ERR!', () => {
      const out = 'npm ERR! code ENOENT\nnpm ERR! syscall open';
      expect(parseNpmInstallSuccessSummary(out)).toBeNull();
    });
  });

  describe('buildVerificationSuccessSummary dispatch', () => {
    it('returns a short opaque tail for any successful command', () => {
      expect(buildVerificationSuccessSummary('npm test', 'all good')).toBe('all good');
      expect(buildVerificationSuccessSummary('npm run build', '')).toBe('ok');
      expect(buildVerificationSuccessSummary('ls -la', 'foo')).toBe('foo');
      expect(buildVerificationSuccessSummary('./scripts/ci.sh', 'ci ok')).toBe('ci ok');
    });
  });

  describe('resolveVerificationSuccessSummary', () => {
    const vitestOut = ' Test Files  8 passed (8)\n      Tests  22 passed (22)\n';

    it('prefers embedded summary from action:check JSON', () => {
      const checkJson = JSON.stringify({
        mode: 'check',
        command: 'npm test 2>&1',
        status: 'completed',
        exitCode: 0,
        summary: '8 files / 22 tests passed',
        output: vitestOut,
      });
      expect(resolveVerificationSuccessSummary('npm test 2>&1', checkJson, { action: 'check' }))
        .toBe('8 files / 22 tests passed');
    });

    it('parses nested output from action:check JSON when summary is missing', () => {
      const checkJson = JSON.stringify({
        mode: 'check',
        command: 'npm test',
        status: 'completed',
        exitCode: 0,
        output: vitestOut,
      });
      expect(resolveVerificationSuccessSummary('npm test', checkJson, { action: 'check' }))
        .toContain('8 passed');
    });

    it('uses raw stdout for foreground commands', () => {
      expect(resolveVerificationSuccessSummary('npm test', vitestOut, { command: 'npm test' }))
        .toContain('8 passed');
    });
  });
});
