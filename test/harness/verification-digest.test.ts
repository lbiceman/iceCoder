import { describe, expect, it } from 'vitest';

import {
  buildVerificationDigest,
  buildVerificationSuccessSummary,
  isBuildVerificationCommand,
  isHarnessVerificationCommand,
  isVerificationCommand,
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
    const vitestOut = ' Test Files  8 passed (8)\n      Tests  22 passed (22)\n';
    const pwOut = '  5 passed (4.4s)';
    const buildOut = '✓ built in 7.49s';
    const ciOut = 'added 60 packages in 4s';

    it('dispatches by command shape', () => {
      expect(buildVerificationSuccessSummary('npm test 2>&1', vitestOut)).toBe('8 files / 22 tests passed');
      expect(buildVerificationSuccessSummary('npx vitest run', vitestOut)).toBe('8 files / 22 tests passed');
      expect(buildVerificationSuccessSummary('npm run build', buildOut)).toBe('build succeeded in 7.49s');
      expect(buildVerificationSuccessSummary('npm run test:e2e', pwOut)).toBe('5 e2e tests passed in 4.4s');
      expect(buildVerificationSuccessSummary('npx playwright test', pwOut)).toBe('5 e2e tests passed in 4.4s');
      expect(buildVerificationSuccessSummary('npm ci', ciOut)).toBe('added 60 packages in 4s');
    });

    it('falls back to generic message when parse cannot find concrete numbers', () => {
      expect(buildVerificationSuccessSummary('npm test', 'all good')).toBe('tests passed');
      expect(buildVerificationSuccessSummary('npm run build', '')).toBe('build succeeded');
    });

    it('returns null for unrelated commands', () => {
      expect(buildVerificationSuccessSummary('ls -la', 'foo')).toBeNull();
      expect(buildVerificationSuccessSummary('git status', 'On branch main')).toBeNull();
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
        .toBe('8 files / 22 tests passed');
    });

    it('uses raw stdout for foreground commands', () => {
      expect(resolveVerificationSuccessSummary('npm test', vitestOut, { command: 'npm test' }))
        .toBe('8 files / 22 tests passed');
    });
  });
});
