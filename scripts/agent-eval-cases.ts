export type AgentEvalCategory =
  | 'edit'
  | 'test-fix'
  | 'refactor'
  | 'compression'
  | 'memory-conflict'
  | 'tool-failure'
  | 'async-subagent'
  | 'eval-mode'
  | 'completion-gate'
  | 'stop-verification';

export interface AgentEvalFileAssertion {
  path: string;
  contains?: string;
  notContains?: string;
  unchanged?: boolean;
}

export type AgentEvalScriptedTurn =
  | {
      type: 'tool';
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: 'final';
      content: string;
    };

export interface AgentEvalCase {
  id: string;
  category: AgentEvalCategory;
  prompt: string;
  files: Record<string, string>;
  memoryFiles?: Record<string, string>;
  verifyCommands: string[];
  expected: {
    requiresTool: boolean;
    requiresVerification?: boolean;
    allowFileChanges?: boolean;
    requiresAnalysisArtifact?: boolean;
    /** 软验证场景：不允许 Harness 强推 shell 验证。 */
    forbidVerification?: boolean;
    /** 通用收尾协议的结构化终态。 */
    completionStatus?: 'completed' | 'completed_unverified' | 'paused' | 'failed' | 'interrupted';
    completionReason?: string;
    /** 最终用户可见文本应包含。 */
    finalContains?: string;
    /** 最后一次成功写文件之后必须再有一次成功的验收命令。 */
    verificationAfterLastWrite?: boolean;
    /** 按子串统计 run_command 调用次数（含失败尝试）。 */
    verificationRuns?: Record<string, { min?: number; max?: number }>;
    /** 不允许出现的 run_command 子串。 */
    forbidCommands?: string[];
    /** 结束后断言活动 checkpoint 为 ProjectCheckpointV3。 */
    checkpoint?: {
      version: 3;
      forbidLegacyFields?: boolean;
      hasCompletion?: boolean;
      migratedFromLegacy?: boolean;
      hasVerificationState?: boolean;
      mutationVersionAtLeast?: number;
    };
  };
  assertions: AgentEvalFileAssertion[];
  maxRounds?: number;
  timeoutMs?: number;
  compactionThreshold?: number;
  compactionTokenThreshold?: number;
  toolsDisabled?: boolean;
  /** 运行前写入旧 v1 checkpoint，验证首次保存升级为 V3。 */
  seedLegacyCheckpoint?: boolean;
  /**
   * 脚本化模型轮次。有此字段时，eval 必须走真实 Harness + 真实工作区工具，
   * mock 指标不得直接判过。
   */
  scriptedTurns?: AgentEvalScriptedTurn[];
}

const basePackageJson = {
  scripts: {
    test: 'node --test',
  },
};

function packageJson(scripts: Record<string, string> = basePackageJson.scripts): string {
  return `${JSON.stringify({ scripts }, null, 2)}\n`;
}

function mathSource(body: string): string {
  return `function add(a, b) {\n  ${body}\n}\n\nmodule.exports = { add };\n`;
}

function mathTest(): string {
  return [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { add } = require('../src/math');",
    '',
    "test('adds numbers', () => {",
    '  assert.equal(add(2, 3), 5);',
    '});',
    '',
  ].join('\n');
}

function mathWorkspace(impl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': packageJson(),
    'src/math.js': mathSource(impl),
    'test/math.test.js': mathTest(),
    ...extra,
  };
}

export const agentEvalCases: AgentEvalCase[] = [
  {
    id: 'single-file-edit',
    category: 'edit',
    prompt: [
      'In this workspace, rename the exported addOne function to increment.',
      'Update every reference and run npm test before finishing.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/math.js': "function addOne(value) {\n  return value + 1;\n}\n\nmodule.exports = { addOne };\n",
      'test/math.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { addOne } = require('../src/math');\n\ntest('adds one', () => {\n  assert.equal(addOne(2), 3);\n});\n",
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/math.js', contains: 'function increment' },
      { path: 'src/math.js', contains: 'module.exports = { increment }' },
      { path: 'test/math.test.js', contains: 'increment(2)' },
      { path: 'test/math.test.js', notContains: 'addOne' },
    ],
  },
  {
    id: 'test-failure-fix',
    category: 'test-fix',
    prompt: [
      'The test suite is failing. Fix the discount calculation implementation only as needed,',
      'then run npm test and report the result.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/discount.js': "function applyDiscount(price, rate) {\n  return price - rate;\n}\n\nmodule.exports = { applyDiscount };\n",
      'test/discount.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { applyDiscount } = require('../src/discount');\n\ntest('applies percentage discounts', () => {\n  assert.equal(applyDiscount(100, 0.2), 80);\n});\n",
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/discount.js', notContains: 'return price - rate;' },
    ],
  },
  {
    id: 'multi-file-refactor',
    category: 'refactor',
    prompt: [
      'Refactor the slug helper so the public function is named createSlug instead of makeSlug.',
      'Update all imports/usages and run npm test.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/slug.js': "function makeSlug(input) {\n  return input.trim().toLowerCase().replace(/\\s+/g, '-');\n}\n\nmodule.exports = { makeSlug };\n",
      'src/index.js': "const { makeSlug } = require('./slug');\n\nfunction buildArticlePath(title) {\n  return `/articles/${makeSlug(title)}`;\n}\n\nmodule.exports = { buildArticlePath };\n",
      'test/slug.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { buildArticlePath } = require('../src');\n\ntest('builds article paths', () => {\n  assert.equal(buildArticlePath('Hello World'), '/articles/hello-world');\n});\n",
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/slug.js', contains: 'function createSlug' },
      { path: 'src/slug.js', contains: 'module.exports = { createSlug }' },
      { path: 'src/index.js', contains: 'createSlug(title)' },
      { path: 'src/index.js', notContains: 'makeSlug' },
    ],
  },
  {
    id: 'tool-failure-recovery',
    category: 'tool-failure',
    prompt: [
      'Update src/greeter.js so greet() says "Hi, <name>!" instead of "Hello, <name>!".',
      'If that path is wrong, search the workspace for the actual file. Run npm test.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/greeting.js': "function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nmodule.exports = { greet };\n",
      'test/greeting.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { greet } = require('../src/greeting');\n\ntest('greets by name', () => {\n  assert.equal(greet('Ada'), 'Hi, Ada!');\n});\n",
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/greeting.js', contains: 'Hi, ${name}!' },
      { path: 'src/greeting.js', notContains: 'Hello, ${name}!' },
    ],
  },
  {
    id: 'compression-recovery',
    category: 'compression',
    prompt: [
      'Continue carefully even if context compaction happens. Change getStatus() to return "ready",',
      'keep the existing export, and run npm test before finishing.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/status.js': "function getStatus() {\n  return 'pending';\n}\n\nmodule.exports = { getStatus };\n",
      'test/status.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { getStatus } = require('../src/status');\n\ntest('status is ready', () => {\n  assert.equal(getStatus(), 'ready');\n});\n",
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/status.js', contains: "return 'ready'" },
    ],
    maxRounds: 8,
    timeoutMs: 240_000,
    compactionThreshold: 2,
    compactionTokenThreshold: 1200,
  },
  {
    id: 'memory-conflict',
    category: 'memory-conflict',
    prompt: [
      'The current user instruction overrides older preferences: update getMode() to return "modern",',
      'then run npm test.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/mode.js': "function getMode() {\n  return 'legacy';\n}\n\nmodule.exports = { getMode };\n",
      'test/mode.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { getMode } = require('../src/mode');\n\ntest('mode is modern', () => {\n  assert.equal(getMode(), 'modern');\n});\n",
    },
    memoryFiles: {
      'old-preference.md': [
        '---',
        'memoryLevel: preference',
        'evidenceStrength: weak',
        '---',
        '',
        'The user previously preferred that agents should not modify code.',
      ].join('\n'),
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/mode.js', contains: "return 'modern'" },
      { path: 'src/mode.js', notContains: "return 'legacy'" },
    ],
  },
  {
    id: 'async-subagent-oauth-context',
    category: 'async-subagent',
    prompt: [
      'Inspect the OAuth login flow before editing.',
      'Then update the callback route to return "oauth-ready" and run npm test.',
      'Use background analysis when gathering context.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/auth/oauth.js': [
        'function buildCallbackResponse() {',
        "  return 'oauth-pending';",
        '}',
        '',
        'module.exports = { buildCallbackResponse };',
        '',
      ].join('\n'),
      'src/routes/callback.js': [
        "const { buildCallbackResponse } = require('../auth/oauth');",
        '',
        'function callbackRoute() {',
        '  return buildCallbackResponse();',
        '}',
        '',
        'module.exports = { callbackRoute };',
        '',
      ].join('\n'),
      'test/oauth.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const { callbackRoute } = require('../src/routes/callback');",
        '',
        "test('oauth callback is ready', () => {",
        "  assert.equal(callbackRoute(), 'oauth-ready');",
        '});',
        '',
      ].join('\n'),
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true, requiresAnalysisArtifact: true },
    assertions: [
      { path: 'src/auth/oauth.js', contains: "return 'oauth-ready'" },
      { path: 'src/auth/oauth.js', notContains: "return 'oauth-pending'" },
    ],
    maxRounds: 10,
  },
  {
    id: 'noisy-test-failure-fix',
    category: 'test-fix',
    prompt: [
      'npm test currently fails. The failure details are at the END of a very noisy log.',
      'Fix src/score.js so applyScore returns price * (1 - rate), then run npm test.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/score.js': "function applyScore(price, rate) {\n  return price - rate;\n}\n\nmodule.exports = { applyScore };\n",
      'test/score.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const { applyScore } = require('../src/score');",
        '',
        "test('applies percentage scores', () => {",
        "  for (let i = 0; i < 300; i++) console.log('setup-noise-' + i + '-' + 'x'.repeat(40));",
        "  assert.equal(applyScore(100, 0.2), 80);",
        '});',
        '',
      ].join('\n'),
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/score.js', notContains: 'return price - rate;' },
      { path: 'src/score.js', contains: 'applyScore' },
    ],
  },
  {
    id: 'multi-round-runtime-stable-edit',
    category: 'edit',
    prompt: [
      'Read src/label.js first, then change exported text() to return "ok".',
      'Run npm test before finishing.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/label.js': "function text() {\n  return 'draft';\n}\n\nmodule.exports = { text };\n",
      'test/label.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { text } = require('../src/label');\n\ntest('label is ok', () => {\n  assert.equal(text(), 'ok');\n});\n",
    },
    verifyCommands: ['npm test'],
    expected: { requiresTool: true, requiresVerification: true },
    assertions: [
      { path: 'src/label.js', contains: "return 'ok'" },
      { path: 'src/label.js', notContains: "return 'draft'" },
    ],
  },
  {
    id: 'eval-mode-tools-disabled',
    category: 'eval-mode',
    prompt: [
      'Tools are disabled for this case. Do not claim that you edited files.',
      'Briefly explain that the requested file change cannot be performed without tools.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'src/locked.js': "function value() {\n  return 'unchanged';\n}\n\nmodule.exports = { value };\n",
    },
    verifyCommands: [],
    expected: { requiresTool: false, allowFileChanges: false },
    assertions: [
      { path: 'src/locked.js', contains: "return 'unchanged'", unchanged: true },
    ],
    toolsDisabled: true,
    maxRounds: 2,
  },
  {
    id: 'gate-simple-python-edit',
    category: 'completion-gate',
    prompt: [
      "Make the one-line low-risk change in src/banner.py: replace `return 'draft'` with `return 'ready'` and preserve the quote style.",
      'After the edit succeeds, do not read the file again or call any other tool; immediately return the final answer.',
      'Do not run shell commands or tests.',
    ].join(' '),
    files: {
      'src/banner.py': "def banner():\n    return 'draft'\n",
    },
    verifyCommands: [],
    expected: {
      requiresTool: true,
      forbidVerification: true,
      completionStatus: 'completed',
      checkpoint: { version: 3, forbidLegacyFields: true, hasCompletion: true },
    },
    assertions: [
      { path: 'src/banner.py', contains: 'def banner()' },
      { path: 'src/banner.py', notContains: "return 'draft'" },
    ],
    maxRounds: 6,
  },
  {
    id: 'gate-explicit-single-check',
    category: 'completion-gate',
    prompt: [
      'Update src/config.js so exported mode is "production".',
      'Completion condition: you must run `node --check src/config.js` and it must succeed before finishing.',
    ].join(' '),
    files: {
      'src/config.js': "module.exports = { mode: 'development' };\n",
    },
    verifyCommands: ['node --check src/config.js'],
    expected: {
      requiresTool: true,
      requiresVerification: true,
      completionStatus: 'completed',
      checkpoint: { version: 3, forbidLegacyFields: true, hasCompletion: true },
    },
    assertions: [
      { path: 'src/config.js', contains: "mode: 'production'" },
      { path: 'src/config.js', notContains: "mode: 'development'" },
    ],
    maxRounds: 6,
  },
  {
    id: 'gate-read-only-finish',
    category: 'completion-gate',
    prompt: [
      'Read settings.json and answer with the configured region.',
      'Do not modify files or run shell commands.',
    ].join(' '),
    files: {
      'settings.json': '{\n  "region": "ap-southeast-1"\n}\n',
    },
    verifyCommands: [],
    expected: {
      requiresTool: true,
      allowFileChanges: false,
      forbidVerification: true,
      completionStatus: 'completed',
      finalContains: 'ap-southeast-1',
      checkpoint: { version: 3, forbidLegacyFields: true, hasCompletion: true },
    },
    assertions: [
      { path: 'settings.json', unchanged: true },
    ],
    maxRounds: 4,
  },
  {
    id: 'gate-required-capability-unavailable',
    category: 'completion-gate',
    prompt: [
      'Tools are unavailable in this case.',
      'Completion condition: you must run `make verify` successfully before finishing.',
      'Do not emit tool syntax or claim that the condition passed; report that it cannot be verified.',
    ].join(' '),
    files: {
      'state.txt': 'unchanged\n',
    },
    verifyCommands: [],
    expected: {
      requiresTool: false,
      allowFileChanges: false,
      completionStatus: 'paused',
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        migratedFromLegacy: true,
      },
    },
    assertions: [
      { path: 'state.txt', unchanged: true },
    ],
    toolsDisabled: true,
    seedLegacyCheckpoint: true,
    maxRounds: 4,
  },
  {
    id: 'local-edit-stop-runs-npm-test',
    category: 'stop-verification',
    prompt: [
      'Fix add() in src/math.js so 2 + 3 equals 5.',
      'The surrounding notes mention `README.md`, `tenantId`, `source of truth` and',
      '`git diff --name-only -- test/`; those are not completion conditions.',
      'After the file change, return the final answer without running tests yourself.',
    ].join(' '),
    files: mathWorkspace('return a - b;'),
    verifyCommands: ['npm test'],
    expected: {
      requiresTool: true,
      requiresVerification: true,
      verificationAfterLastWrite: true,
      completionStatus: 'completed',
      completionReason: 'verification_passed',
      verificationRuns: { 'npm test': { min: 1 } },
      forbidCommands: ['git diff', 'README.md', 'tenantId'],
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
        mutationVersionAtLeast: 1,
      },
    },
    assertions: [
      { path: 'src/math.js', contains: 'return a + b;' },
      { path: 'src/math.js', notContains: 'return a - b;' },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/math.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: { path: 'src/math.js', search: 'return a - b;', replace: 'return a + b;' },
      },
      { type: 'final', content: 'Fixed add() to return a + b.' },
    ],
    maxRounds: 8,
    timeoutMs: 90_000,
  },
  {
    id: 'local-edit-stale-after-second-write',
    category: 'stop-verification',
    prompt: [
      'Fix add() in src/math.js, run npm test, then add a trailing comment to the same file.',
      'After the second edit, return the final answer without running tests again.',
    ].join(' '),
    files: mathWorkspace('return a - b;'),
    verifyCommands: ['npm test'],
    expected: {
      requiresTool: true,
      requiresVerification: true,
      verificationAfterLastWrite: true,
      completionStatus: 'completed',
      completionReason: 'verification_passed',
      verificationRuns: { 'npm test': { min: 2 } },
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
        mutationVersionAtLeast: 2,
      },
    },
    assertions: [
      { path: 'src/math.js', contains: 'return a + b;' },
      { path: 'src/math.js', contains: 'keep comment' },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/math.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: { path: 'src/math.js', search: 'return a - b;', replace: 'return a + b;' },
      },
      { type: 'tool', name: 'run_command', arguments: { command: 'npm test' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: {
          path: 'src/math.js',
          search: 'return a + b;',
          replace: 'return a + b; // keep comment',
        },
      },
      { type: 'final', content: 'Added a comment after tests passed.' },
    ],
    maxRounds: 10,
    timeoutMs: 90_000,
  },
  {
    id: 'local-git-diff-noise-does-not-block',
    category: 'stop-verification',
    prompt: [
      'Fix add() in src/math.js, run npm test, then inspect `git diff --name-only -- test/`.',
      'Return the final answer after that inspection.',
    ].join(' '),
    files: mathWorkspace('return a - b;'),
    verifyCommands: ['npm test'],
    expected: {
      requiresTool: true,
      requiresVerification: true,
      verificationAfterLastWrite: true,
      completionStatus: 'completed',
      completionReason: 'verification_passed',
      verificationRuns: { 'npm test': { min: 1, max: 1 } },
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
      },
    },
    assertions: [
      { path: 'src/math.js', contains: 'return a + b;' },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/math.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: { path: 'src/math.js', search: 'return a - b;', replace: 'return a + b;' },
      },
      { type: 'tool', name: 'run_command', arguments: { command: 'npm test' } },
      {
        type: 'tool',
        name: 'run_command',
        arguments: { command: 'git diff --name-only -- test/' },
      },
      { type: 'final', content: 'Tests passed; git diff failed and is not required.' },
    ],
    maxRounds: 10,
    timeoutMs: 90_000,
  },
  {
    id: 'local-runtime-default-fail-unverified',
    category: 'stop-verification',
    prompt: [
      'Change src/math.js. Do not claim tests passed.',
      'After the edit, return the final answer without running tests yourself.',
    ].join(' '),
    files: mathWorkspace('return a - b;'),
    verifyCommands: [],
    expected: {
      requiresTool: true,
      completionStatus: 'completed_unverified',
      completionReason: 'verification_failed',
      verificationRuns: { 'npm test': { min: 2 } },
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
      },
    },
    assertions: [
      { path: 'src/math.js', contains: 'return a - b + 0;' },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/math.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: {
          path: 'src/math.js',
          search: 'return a - b;',
          replace: 'return a - b + 0;',
        },
      },
      { type: 'final', content: 'First stop proposal.' },
      { type: 'final', content: 'Second stop proposal after the continuation.' },
    ],
    maxRounds: 10,
    timeoutMs: 90_000,
  },
  {
    id: 'local-explicit-must-run-failed',
    category: 'stop-verification',
    prompt: [
      'Change src/math.js.',
      'Completion condition: you must run `npm test` and it must succeed before finishing.',
      'After the edit, return the final answer without running tests yourself.',
    ].join(' '),
    files: mathWorkspace('return a - b;'),
    verifyCommands: [],
    expected: {
      requiresTool: true,
      completionStatus: 'failed',
      completionReason: 'verification_failed',
      verificationRuns: { 'npm test': { min: 2 } },
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
      },
    },
    assertions: [
      { path: 'src/math.js', contains: 'return a - b + 0;' },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/math.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: {
          path: 'src/math.js',
          search: 'return a - b;',
          replace: 'return a - b + 0;',
        },
      },
      { type: 'final', content: 'First stop proposal.' },
      { type: 'final', content: 'Second stop proposal after the continuation.' },
    ],
    maxRounds: 10,
    timeoutMs: 90_000,
  },
  {
    id: 'local-user-check-overrides-npm-test',
    category: 'stop-verification',
    prompt: [
      'Update src/banner.js so banner() returns ready.',
      'Completion condition: you must run `node --check src/banner.js`.',
      'After the edit, return the final answer without running tests yourself.',
    ].join(' '),
    files: {
      'package.json': packageJson({ test: 'node -e "process.exit(1)"' }),
      'src/banner.js': "function banner() {\n  return 'draft';\n}\n\nmodule.exports = { banner };\n",
    },
    verifyCommands: ['node --check src/banner.js'],
    expected: {
      requiresTool: true,
      requiresVerification: true,
      verificationAfterLastWrite: true,
      completionStatus: 'completed',
      completionReason: 'verification_passed',
      verificationRuns: { 'node --check src/banner.js': { min: 1 } },
      forbidCommands: ['npm test'],
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
      },
    },
    assertions: [
      { path: 'src/banner.js', contains: "return 'ready';" },
      { path: 'src/banner.js', notContains: "return 'draft';" },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/banner.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: {
          path: 'src/banner.js',
          search: "return 'draft';",
          replace: "return 'ready';",
        },
      },
      { type: 'final', content: 'Updated banner() to return ready.' },
    ],
    maxRounds: 8,
    timeoutMs: 90_000,
  },
  {
    id: 'local-write-new-file-runs-npm-test',
    category: 'stop-verification',
    prompt: [
      'Create src/sum.js exporting add(a, b) that returns a + b.',
      'After writing the file, return the final answer without running tests yourself.',
    ].join(' '),
    files: {
      'package.json': packageJson(),
      'test/sum.test.js': [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const { add } = require('../src/sum');",
        '',
        "test('adds numbers', () => {",
        '  assert.equal(add(2, 3), 5);',
        '});',
        '',
      ].join('\n'),
    },
    verifyCommands: ['npm test'],
    expected: {
      requiresTool: true,
      requiresVerification: true,
      verificationAfterLastWrite: true,
      completionStatus: 'completed',
      completionReason: 'verification_passed',
      verificationRuns: { 'npm test': { min: 1 } },
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
        mutationVersionAtLeast: 1,
      },
    },
    assertions: [
      { path: 'src/sum.js', contains: 'function add' },
      { path: 'src/sum.js', contains: 'return a + b' },
    ],
    scriptedTurns: [
      {
        type: 'tool',
        name: 'write_file',
        arguments: {
          path: 'src/sum.js',
          content: mathSource('return a + b;'),
        },
      },
      { type: 'final', content: 'Created src/sum.js with add().' },
    ],
    maxRounds: 8,
    timeoutMs: 90_000,
  },
  {
    id: 'local-engineering-edit-no-plan-unverified',
    category: 'stop-verification',
    prompt: [
      'Change src/app.js so label() returns ready.',
      'After the edit, return the final answer. Do not invent npm ci, build, or test commands.',
    ].join(' '),
    files: {
      'src/app.js': "function label() {\n  return 'draft';\n}\n\nmodule.exports = { label };\n",
    },
    verifyCommands: [],
    expected: {
      requiresTool: true,
      completionStatus: 'completed_unverified',
      completionReason: 'verification_plan_unavailable',
      forbidCommands: ['npm test', 'npm ci', 'npm run build', 'git diff'],
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
      },
    },
    assertions: [
      { path: 'src/app.js', contains: "return 'ready';" },
      { path: 'src/app.js', notContains: "return 'draft';" },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/app.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: {
          path: 'src/app.js',
          search: "return 'draft';",
          replace: "return 'ready';",
        },
      },
      { type: 'final', content: 'Updated label() to return ready.' },
    ],
    maxRounds: 6,
    timeoutMs: 60_000,
  },
  {
    id: 'local-mutating-verify-command-not-fresh',
    category: 'stop-verification',
    prompt: [
      'Update src/banner.js so banner() returns ready.',
      'Completion condition: you must run `node scripts/stamp.js`.',
      'After the edit, return the final answer without running tests yourself.',
    ].join(' '),
    files: {
      'scripts/stamp.js': [
        "const fs = require('fs');",
        "const path = require('path');",
        "fs.mkdirSync('src', { recursive: true });",
        "fs.writeFileSync(path.join('src', 'stamp.js'), 'module.exports = 1;\\n');",
        '',
      ].join('\n'),
      'src/banner.js': "function banner() {\n  return 'draft';\n}\n\nmodule.exports = { banner };\n",
    },
    verifyCommands: [],
    expected: {
      requiresTool: true,
      completionStatus: 'paused',
      completionReason: 'verification_unavailable',
      verificationRuns: { 'node scripts/stamp.js': { min: 1 } },
      forbidCommands: ['npm test', 'npm ci'],
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
      },
    },
    assertions: [
      { path: 'src/banner.js', contains: "return 'ready';" },
      { path: 'src/stamp.js', contains: 'module.exports = 1;' },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/banner.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: {
          path: 'src/banner.js',
          search: "return 'draft';",
          replace: "return 'ready';",
        },
      },
      { type: 'final', content: 'Updated banner() to return ready.' },
    ],
    maxRounds: 8,
    timeoutMs: 60_000,
  },
  {
    id: 'local-explicit-two-commands',
    category: 'stop-verification',
    prompt: [
      'Fix add() in src/math.js so 2 + 3 equals 5.',
      'Completion condition: you must run `node --check src/math.js` and `npm test`.',
      'After the edit, return the final answer without running those commands yourself.',
    ].join(' '),
    files: mathWorkspace('return a - b;'),
    verifyCommands: ['node --check src/math.js', 'npm test'],
    expected: {
      requiresTool: true,
      requiresVerification: true,
      verificationAfterLastWrite: true,
      completionStatus: 'completed',
      completionReason: 'verification_passed',
      verificationRuns: {
        'node --check src/math.js': { min: 1 },
        'npm test': { min: 1 },
      },
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
        hasVerificationState: true,
      },
    },
    assertions: [
      { path: 'src/math.js', contains: 'return a + b;' },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'src/math.js' } },
      {
        type: 'tool',
        name: 'edit_file',
        arguments: { path: 'src/math.js', search: 'return a - b;', replace: 'return a + b;' },
      },
      { type: 'final', content: 'Fixed add() to return a + b.' },
    ],
    maxRounds: 10,
    timeoutMs: 90_000,
  },
  {
    id: 'local-read-only-no-file-change',
    category: 'stop-verification',
    prompt: [
      'Read settings.json and answer with the configured region.',
      'Do not modify files or run shell commands.',
    ].join(' '),
    files: {
      'settings.json': '{\n  "region": "ap-southeast-1"\n}\n',
    },
    verifyCommands: [],
    expected: {
      requiresTool: true,
      allowFileChanges: false,
      forbidVerification: true,
      completionStatus: 'completed',
      completionReason: 'verification_not_required',
      finalContains: 'ap-southeast-1',
      forbidCommands: ['npm test', 'npm ci', 'git'],
      checkpoint: {
        version: 3,
        forbidLegacyFields: true,
        hasCompletion: true,
      },
    },
    assertions: [
      { path: 'settings.json', unchanged: true },
    ],
    scriptedTurns: [
      { type: 'tool', name: 'read_file', arguments: { path: 'settings.json' } },
      { type: 'final', content: 'The configured region is ap-southeast-1.' },
    ],
    maxRounds: 4,
    timeoutMs: 30_000,
  },
];
