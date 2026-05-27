import { describe, expect, it } from 'vitest';
import {
  classifyShellCommand,
  pickBackgroundHardTimeout,
  pickForegroundTimeout,
  SOFT_TIMEOUT_MS,
  HARD_TIMEOUT_DEFAULT_MS,
  HARD_TIMEOUT_LONG_MS,
  SHORT_TIMEOUT_MAX_MS,
  BG_SUMMARY_INTERVAL_MS,
} from '../../src/tools/shell-runtime-classifier.js';

describe('shell-runtime-classifier — constants', () => {
  it('SOFT_TIMEOUT_MS is 8 seconds', () => {
    expect(SOFT_TIMEOUT_MS).toBe(8_000);
  });

  it('HARD_TIMEOUT_DEFAULT_MS is 5 minutes', () => {
    expect(HARD_TIMEOUT_DEFAULT_MS).toBe(5 * 60 * 1000);
  });

  it('HARD_TIMEOUT_LONG_MS is 24 hours', () => {
    expect(HARD_TIMEOUT_LONG_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('SHORT_TIMEOUT_MAX_MS is 10 seconds', () => {
    expect(SHORT_TIMEOUT_MAX_MS).toBe(10_000);
  });

  it('BG_SUMMARY_INTERVAL_MS is 5 minutes', () => {
    expect(BG_SUMMARY_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});

describe('classifyShellCommand — long', () => {
  it.each([
    ['npm test'],
    ['npm t'],
    ['npm run test'],
    ['npm run dev'],
    ['npm run start'],
    ['npm run build'],
    ['npm run watch'],
    ['pnpm test'],
    ['yarn test'],
    ['bun test'],
    ['pnpm run dev'],
    ['vitest'],
    ['vitest run'],
    ['jest'],
    ['playwright test'],
    ['cypress run'],
    ['tsc --watch'],
    ['tsc -w'],
    ['docker build .'],
    ['docker run nginx'],
    ['docker compose up'],
    ['pip install requests'],
    ['poetry install'],
    ['conda install numpy'],
    ['git clone https://github.com/foo/bar.git'],
    ['curl https://example.com/file.zip -O output.zip'],
    ['curl -o output.zip https://example.com/file.zip'],
  ])('classifies "%s" as long', (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('long');
  });

  it('treats leading whitespace', () => {
    expect(classifyShellCommand('   npm test   ')).toBe('long');
  });
});

describe('classifyShellCommand — short', () => {
  it.each([
    ['git status'],
    ['git diff'],
    ['git log'],
    ['git log -n 5'],
    ['git branch'],
    ['git show --stat HEAD'],
    ['git rev-parse HEAD'],
    ['git config --get user.email'],
    ['ls'],
    ['ls -la'],
    ['dir'],
    ['pwd'],
    ['cat README.md'],
    ['type package.json'],
    ['head -n 20 file.txt'],
    ['tail -n 10 log.txt'],
    ['wc -l file.txt'],
    ['echo hello'],
    ['which node'],
    ['where npm'],
    ['whoami'],
    ['hostname'],
    ['tsc --noEmit'],
    ['node --version'],
    ['npm --version'],
    ['git --version'],
    ['npm -v'],
    ['node -v'],
  ])('classifies "%s" as short', (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('short');
  });

  it('git diff --stat is NOT short (long-ish diff with stat is still short by spec but excluded)', () => {
    // Per spec: /^git\s+diff(?!\s+--stat)/ — so `git diff --stat` falls through to auto
    expect(classifyShellCommand('git diff --stat')).toBe('auto');
  });
});

describe('classifyShellCommand — auto (fallback)', () => {
  it.each([
    ['some-unknown-command --flag'],
    ['./scripts/custom.sh'],
    ['node scripts/check.mjs'],
    ['python my-script.py'],
    ['make'],
    ['mvn install'],          // not in either list; falls through
    ['gradlew build'],
    [''],                      // empty → auto
    ['   '],                   // whitespace only → auto
  ])('classifies "%s" as auto', (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('auto');
  });
});

describe('classifyShellCommand — edge cases', () => {
  it('npm --version is short, not long (specificity)', () => {
    // long pattern excludes `--version` / `--help` via the version regex
    expect(classifyShellCommand('npm --version')).toBe('short');
    expect(classifyShellCommand('vitest --version')).not.toBe('long');
  });

  it('vitest --help is not long', () => {
    expect(classifyShellCommand('vitest --help')).not.toBe('long');
  });

  it('git status with extra args is short', () => {
    expect(classifyShellCommand('git status --short')).toBe('short');
  });

  it('does NOT match commands that merely contain a long keyword mid-string', () => {
    expect(classifyShellCommand('echo npm test')).toBe('short'); // matches echo
  });
});

describe('pickBackgroundHardTimeout', () => {
  it('returns 24h for long', () => {
    expect(pickBackgroundHardTimeout('long')).toBe(HARD_TIMEOUT_LONG_MS);
  });

  it('returns 5min for explicit background:true on auto', () => {
    expect(pickBackgroundHardTimeout('auto', { explicitBackground: true }))
      .toBe(HARD_TIMEOUT_DEFAULT_MS);
  });

  it('returns 5min for explicit background:true on short', () => {
    expect(pickBackgroundHardTimeout('short', { explicitBackground: true }))
      .toBe(HARD_TIMEOUT_DEFAULT_MS);
  });

  it('returns 5min for auto without explicit (Phase 1 default)', () => {
    expect(pickBackgroundHardTimeout('auto')).toBe(HARD_TIMEOUT_DEFAULT_MS);
  });

  it('long beats explicit background flag', () => {
    expect(pickBackgroundHardTimeout('long', { explicitBackground: true }))
      .toBe(HARD_TIMEOUT_LONG_MS);
  });
});

describe('pickForegroundTimeout', () => {
  it('caps short to 10s when args.timeout is undefined', () => {
    expect(pickForegroundTimeout('short', undefined)).toBe(SHORT_TIMEOUT_MAX_MS);
  });

  it('caps short to 10s when args.timeout=30000', () => {
    expect(pickForegroundTimeout('short', 30_000)).toBe(SHORT_TIMEOUT_MAX_MS);
  });

  it('does NOT raise short above explicit smaller args.timeout', () => {
    expect(pickForegroundTimeout('short', 5_000)).toBe(5_000);
  });

  it('auto uses args.timeout when provided', () => {
    expect(pickForegroundTimeout('auto', 20_000)).toBe(20_000);
  });

  it('auto uses 30s default when undefined', () => {
    expect(pickForegroundTimeout('auto', undefined)).toBe(30_000);
  });

  it('auto honors custom default', () => {
    expect(pickForegroundTimeout('auto', undefined, 60_000)).toBe(60_000);
  });

  it('long: foreground timeout falls through to user/default (rare path, shouldBackground would normally trigger)', () => {
    expect(pickForegroundTimeout('long', undefined)).toBe(30_000);
    expect(pickForegroundTimeout('long', 45_000)).toBe(45_000);
  });

  it('ignores zero / negative args.timeout', () => {
    expect(pickForegroundTimeout('auto', 0)).toBe(30_000);
    expect(pickForegroundTimeout('auto', -1)).toBe(30_000);
  });
});
