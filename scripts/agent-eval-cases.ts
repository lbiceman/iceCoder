export type AgentEvalCategory =
  | 'edit'
  | 'test-fix'
  | 'refactor'
  | 'compression'
  | 'memory-conflict'
  | 'tool-failure'
  | 'async-subagent'
  | 'eval-mode'
  | 'completion-gate';

export interface AgentEvalFileAssertion {
  path: string;
  contains?: string;
  notContains?: string;
  unchanged?: boolean;
}

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
    /** 最终用户可见文本应包含。 */
    finalContains?: string;
  };
  assertions: AgentEvalFileAssertion[];
  maxRounds?: number;
  compactionThreshold?: number;
  compactionTokenThreshold?: number;
  toolsDisabled?: boolean;
}

const basePackageJson = {
  scripts: {
    test: 'node --test',
  },
};

function packageJson(): string {
  return `${JSON.stringify(basePackageJson, null, 2)}\n`;
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
      'Make the one-line low-risk change in src/banner.py: return "ready" instead of "draft".',
      'Do not run shell commands or tests; a successful file edit is enough, then finish.',
    ].join(' '),
    files: {
      'src/banner.py': "def banner():\n    return 'draft'\n",
    },
    verifyCommands: [],
    expected: {
      requiresTool: true,
      forbidVerification: true,
      completionStatus: 'completed',
    },
    assertions: [
      { path: 'src/banner.py', contains: "return 'ready'" },
      { path: 'src/banner.py', notContains: "return 'draft'" },
    ],
    maxRounds: 4,
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
    },
    assertions: [
      { path: 'settings.json', unchanged: true },
    ],
    maxRounds: 4,
  },
];
