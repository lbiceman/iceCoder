import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildVerificationPlan,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  parseVerificationCommandsFromGoal,
  resolveVerificationPlan,
} from '../../src/harness/verification-plan.js';

const temporaryRoots: string[] = [];

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ice-verification-plan-'));
  temporaryRoots.push(root);
  return root;
}

function writeJson(root: string, name: string, value: unknown): void {
  writeFileSync(join(root, name), JSON.stringify(value), 'utf8');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('parseVerificationCommandsFromGoal', () => {
  it.each([
    ['`src/foo.ts`，验收命令：`npm test`。', ['npm test']],
    ['`README.md`；完成条件：必须运行 `pytest -q`。', ['pytest -q']],
    ['`available = onHand - reserved`，must run `cargo test`.', ['cargo test']],
    ['ordinary example `npm run build`, must pass `npm test`.', ['npm test']],
    ['ordinary `build`; completion condition: must run `go test ./...`.', ['go test ./...']],
  ])('does not reverse-capture ordinary backticks: %s', (goal, expected) => {
    expect(parseVerificationCommandsFromGoal(goal)).toEqual(expected);
  });

  it('extracts only backtick commands governed by an adjacent Chinese marker', () => {
    const goal = [
      '请阅读 `README.md`，不要把普通反引号当命令。',
      '示例可使用 `npm run build`，但它不是完成条件。',
      '验收命令：`npm test`、`npm run lint`、`npm test`。',
    ].join('\n');

    expect(parseVerificationCommandsFromGoal(goal)).toEqual([
      'npm test',
      'npm run lint',
    ]);
  });

  it.each([
    '完成条件：必须运行 `pnpm test`。',
    '完成条件：必须通过 `pnpm test`。',
    '验收命令：`pnpm test`。',
    '验收命令是 `pnpm test`。',
    '验收命令为 `pnpm test`。',
    '验收命令 `pnpm test`。',
    '完成条件：`pnpm test`。',
    '你必须运行 `pnpm test` 才能结束。',
    'Acceptance: `pnpm test`.',
    'Completion condition: `pnpm test`.',
    'Before finish: `pnpm test`.',
    'Must run `pnpm test`.',
    'Must pass `pnpm test`.',
    '`pnpm test` before finish.',
  ])('recognizes the strict marker in %s', (goal) => {
    expect(parseVerificationCommandsFromGoal(goal)).toEqual(['pnpm test']);
  });

  it('rejects ordinary backticks and unsafe command strings', () => {
    const tooLong = 'x'.repeat(501);
    const goal = [
      '可以参考 `npm test`，但没有验收 marker。',
      `验收命令：\`npm test\`、\`has\u0000nul\`、\`${tooLong}\`.`,
      '完成条件：必须运行 ``。',
    ].join('\n');

    expect(parseVerificationCommandsFromGoal(goal)).toEqual(['npm test']);
  });

  it('parses a markdown command list after an explicit marker', () => {
    expect(parseVerificationCommandsFromGoal([
      '验收命令：',
      '- `npm test`',
      '- `turbo run lint`',
    ].join('\n'))).toEqual(['npm test', 'turbo run lint']);
  });

  it('preserves explicit commands without applying the legacy runner whitelist', () => {
    expect(parseVerificationCommandsFromGoal([
      '验收命令：`turbo test`、`nx affected --target=test`、`cross-env NODE_ENV=test vitest`、',
      '`bin/ci.sh`、`C:\\repo\\tools\\verify.exe --all`。',
    ].join(''))).toEqual([
      'turbo test',
      'nx affected --target=test',
      'cross-env NODE_ENV=test vitest',
      'bin/ci.sh',
      'C:\\repo\\tools\\verify.exe --all',
    ]);
  });

  it.each([
    'acceptance criteria mention `npm test` here',
    'The acceptance criteria mention `npm test` here.',
    'This completion condition mentions `npm test` here.',
  ])('rejects loose marker prose: %s', (goal) => {
    expect(parseVerificationCommandsFromGoal(goal)).toEqual([]);
  });
});

describe('buildVerificationPlan', () => {
  it('builds a stable plan with safe defaults and ordered deduplication', () => {
    const root = temporaryWorkspace();
    const first = buildVerificationPlan({
      source: 'user',
      workspaceRoot: root,
      commands: [' npm test ', 'npm run lint', 'npm test', '', 'bad\ncommand'],
    });
    const second = buildVerificationPlan({
      source: 'user',
      workspaceRoot: root,
      commands: ['npm test', 'npm run lint'],
    });

    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    expect(first?.commands).toEqual([
      { command: 'npm test', required: true, timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS },
      { command: 'npm run lint', required: true, timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS },
    ]);
    expect(first?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.id).toBe(`verification:${first?.fingerprint.slice(0, 16)}`);
  });

  it('fingerprints source, command order, flags, timeout, and workspace semantics', () => {
    const root = temporaryWorkspace();
    const baseline = buildVerificationPlan({
      source: 'user',
      workspaceRoot: root,
      commands: [
        { command: 'npm test', required: true, timeoutMs: 1000 },
        { command: 'npm run lint', required: false, timeoutMs: 2000 },
      ],
    })!;
    const variants = [
      buildVerificationPlan({
        source: 'project',
        workspaceRoot: root,
        commands: baseline.commands,
      }),
      buildVerificationPlan({
        source: 'user',
        workspaceRoot: root,
        commands: [...baseline.commands].reverse(),
      }),
      buildVerificationPlan({
        source: 'user',
        workspaceRoot: root,
        commands: [{ ...baseline.commands[0]!, required: false }, baseline.commands[1]!],
      }),
      buildVerificationPlan({
        source: 'user',
        workspaceRoot: root,
        commands: [{ ...baseline.commands[0]!, timeoutMs: 1001 }, baseline.commands[1]!],
      }),
      buildVerificationPlan({
        source: 'user',
        workspaceRoot: join(root, 'other'),
        commands: baseline.commands,
      }),
    ];

    expect(new Set(variants.map(plan => plan?.fingerprint)).size).toBe(variants.length);
    expect(variants.every(plan => plan?.fingerprint !== baseline.fingerprint)).toBe(true);
  });

  it('returns null when every command is invalid', () => {
    expect(buildVerificationPlan({
      source: 'runtime_default',
      workspaceRoot: temporaryWorkspace(),
      commands: ['', 'bad\r\ncommand', `x${'y'.repeat(500)}`, 'has\u0000nul'],
    })).toBeNull();
  });
});

describe('resolveVerificationPlan', () => {
  it('prefers strict user commands over project and runtime defaults', async () => {
    const root = temporaryWorkspace();
    writeJson(root, '.icecoder.json', { verificationCommands: ['npm run project-check'] });
    writeJson(root, 'package.json', { scripts: { test: 'vitest --run' } });
    writeFileSync(join(root, 'pnpm-lock.yaml'), '', 'utf8');

    await expect(resolveVerificationPlan({
      goal: '完成条件：必须运行 `cargo test`、`cargo clippy`。',
      workspaceRoot: root,
    })).resolves.toMatchObject({
      kind: 'resolved',
      plan: {
        source: 'user',
        commands: [
          { command: 'cargo test', required: true, timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS },
          { command: 'cargo clippy', required: true, timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS },
        ],
      },
    });
  });

  it('uses ordered project commands when no strict user marker exists', async () => {
    const root = temporaryWorkspace();
    writeJson(root, 'icecoder.json', {
      verificationCommands: [' npm run verify ', 'npm run lint', 'npm run verify', 42],
    });
    writeJson(root, 'package.json', { scripts: { test: 'vitest --run' } });
    const warnings: Array<{ kind: string; source: string }> = [];

    await expect(resolveVerificationPlan({
      goal: '普通说明里出现 `npm run build`。',
      workspaceRoot: root,
      onWarning: warning => warnings.push(warning),
    })).resolves.toMatchObject({
      kind: 'resolved',
      plan: {
        source: 'project',
        commands: [
          { command: 'npm run verify', required: true, timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS },
          { command: 'npm run lint', required: true, timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS },
        ],
      },
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'malformed',
        source: 'workspace_config',
      }),
    ]);
  });

  it('treats an explicit empty project command list as disabling runtime defaults', async () => {
    const root = temporaryWorkspace();
    writeJson(root, '.icecoder.json', { verificationCommands: [] });
    writeJson(root, 'package.json', { scripts: { test: 'vitest --run' } });

    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: root,
    })).resolves.toEqual({ kind: 'disabled', source: 'project' });
  });

  it('returns project invalid when every configured entry is blank or non-string', async () => {
    const root = temporaryWorkspace();
    writeJson(root, '.icecoder.json', { verificationCommands: ['  ', 42] });
    writeJson(root, 'package.json', { scripts: { test: 'vitest --run' } });
    const warnings: Array<{ kind: string; source: string }> = [];

    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: root,
      onWarning: warning => warnings.push(warning),
    })).resolves.toEqual({
      kind: 'invalid',
      source: 'project',
      reason: 'invalid_project_commands',
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.every(warning => warning.source === 'workspace_config')).toBe(true);
  });

  it.each([
    'bad\u0000command',
    'bad\ncommand',
    'x'.repeat(501),
  ])('warns and does not fall back for unsafe explicit command %#', async (candidate) => {
    const root = temporaryWorkspace();
    writeJson(root, 'package.json', { scripts: { test: 'vitest --run' } });
    const warnings: Array<{ kind: string; source: string }> = [];

    await expect(resolveVerificationPlan({
      goal: `验收命令：\`${candidate}\`。`,
      workspaceRoot: root,
      onWarning: warning => warnings.push(warning),
    })).resolves.toEqual({
      kind: 'invalid',
      source: 'user',
      reason: 'unsafe_user_command',
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'invalid_command',
        source: 'user_goal',
      }),
    ]);
  });

  it('warns and falls back when marked values are simply not commands', async () => {
    const root = temporaryWorkspace();
    writeJson(root, 'package.json', { scripts: { test: 'vitest --run' } });
    const warnings: Array<{ kind: string; source: string }> = [];

    await expect(resolveVerificationPlan({
      goal: '验收命令：`src/foo.ts`、`docs/runbook.md`、`source of truth`。',
      workspaceRoot: root,
      onWarning: warning => warnings.push(warning),
    })).resolves.toMatchObject({
      kind: 'resolved',
      plan: {
        source: 'runtime_default',
        commands: [{ command: 'npm test' }],
      },
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.every(warning => warning.kind === 'invalid_command')).toBe(true);
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm test'],
    ['yarn.lock', 'yarn test'],
    ['bun.lock', 'bun test'],
    ['bun.lockb', 'bun test'],
    ['package-lock.json', 'npm test'],
  ])('selects %s for the safe test default', async (lockfile, expectedCommand) => {
    const root = temporaryWorkspace();
    writeJson(root, 'package.json', {
      scripts: {
        test: 'vitest --run',
        build: 'dangerous-build',
        migrate: 'dangerous-migrate',
        snapshot: 'dangerous-snapshot',
      },
    });
    writeFileSync(join(root, lockfile), '', 'utf8');

    await expect(resolveVerificationPlan({
      goal: '实现功能，没有验收 marker。',
      workspaceRoot: root,
    })).resolves.toMatchObject({
      kind: 'resolved',
      plan: {
        source: 'runtime_default',
        commands: [{ command: expectedCommand, required: true }],
      },
    });
  });

  it('falls back to npm without a lockfile', async () => {
    const root = temporaryWorkspace();
    writeJson(root, 'package.json', { scripts: { test: 'node test.js' } });

    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: root,
    })).resolves.toMatchObject({
      kind: 'resolved',
      plan: {
        source: 'runtime_default',
        commands: [{ command: 'npm test', required: true }],
      },
    });
  });

  it('falls through malformed files and never selects non-test scripts', async () => {
    const malformedConfigRoot = temporaryWorkspace();
    writeFileSync(join(malformedConfigRoot, '.icecoder.json'), '{', 'utf8');
    writeFileSync(join(malformedConfigRoot, 'package.json'), '{', 'utf8');
    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: malformedConfigRoot,
    })).resolves.toEqual({ kind: 'unavailable' });

    const buildOnlyRoot = temporaryWorkspace();
    writeJson(buildOnlyRoot, 'package.json', {
      scripts: { build: 'vite build', migrate: 'db migrate', snapshot: 'snapshot' },
    });
    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: buildOnlyRoot,
    })).resolves.toEqual({ kind: 'unavailable' });
  });

  it('warns for malformed config while continuing to the next configured name', async () => {
    const root = temporaryWorkspace();
    writeFileSync(join(root, '.icecoder.json'), '{', 'utf8');
    writeJson(root, 'icecoder.json', { verificationCommands: ['npm run verify'] });
    const warnings: Array<{ kind: string; path: string; code?: string }> = [];

    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: root,
      onWarning: warning => warnings.push(warning),
    })).resolves.toMatchObject({
      kind: 'resolved',
      plan: {
        source: 'project',
        commands: [{ command: 'npm run verify' }],
      },
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'malformed',
        path: join(root, '.icecoder.json'),
      }),
    ]);
  });

  it('does not warn for ENOENT but reports unreadable files without throwing', async () => {
    const missingRoot = temporaryWorkspace();
    writeJson(missingRoot, 'package.json', { scripts: { test: 'vitest --run' } });
    const missingWarnings: Array<{ kind: string; path: string; code?: string }> = [];
    await resolveVerificationPlan({
      goal: '',
      workspaceRoot: missingRoot,
      onWarning: warning => missingWarnings.push(warning),
    });
    expect(missingWarnings).toEqual([]);

    const unreadableRoot = temporaryWorkspace();
    mkdirSync(join(unreadableRoot, '.icecoder.json'));
    writeJson(unreadableRoot, 'package.json', { scripts: { test: 'vitest --run' } });
    const unreadableWarnings: Array<{ kind: string; path: string; code?: string }> = [];
    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: unreadableRoot,
      onWarning: warning => unreadableWarnings.push(warning),
    })).resolves.toMatchObject({
      kind: 'resolved',
      plan: { source: 'runtime_default' },
    });
    expect(unreadableWarnings).toEqual([
      expect.objectContaining({
        kind: 'read_error',
        path: join(unreadableRoot, '.icecoder.json'),
      }),
    ]);
  });

  it('reports a malformed package manifest while returning no default plan', async () => {
    const root = temporaryWorkspace();
    writeFileSync(join(root, 'package.json'), '{', 'utf8');
    const warnings: Array<{ kind: string; source: string; path: string }> = [];

    await expect(resolveVerificationPlan({
      goal: '',
      workspaceRoot: root,
      onWarning: warning => warnings.push(warning),
    })).resolves.toEqual({ kind: 'unavailable' });
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'malformed',
        source: 'package_manifest',
        path: join(root, 'package.json'),
      }),
    ]);
  });
});
