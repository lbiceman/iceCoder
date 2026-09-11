import { describe, expect, it } from 'vitest';

import { parseSubAgentOutput } from '../../src/harness/sub-agent-output-parser.js';
import { buildSubAgentTaskPrompt, inferKindFromIntent } from '../../src/harness/sub-agent-prompts.js';

describe('sub-agent prompts', () => {
  it('includes required output sections for each kind', () => {
    expect(buildSubAgentTaskPrompt({ kind: 'explorer', task: 'Map auth' })).toContain('Modules');
    expect(buildSubAgentTaskPrompt({ kind: 'search', task: 'Find auth' })).toContain('References');
    expect(buildSubAgentTaskPrompt({ kind: 'review', task: 'Review auth' })).toContain('Risks');
    expect(buildSubAgentTaskPrompt({ kind: 'dependency', task: 'Deps' })).toContain('Circular Dependencies');
    expect(buildSubAgentTaskPrompt({ kind: 'test_analysis', task: 'Tests' })).toContain('Test Entrypoints');
  });

  it('parses structured fields from Markdown sections', () => {
    const parsed = parseSubAgentOutput('search', [
      '# Files',
      '- src/auth/index.ts',
      '# Functions',
      '- login()',
      '# References',
      '- OAuth middleware',
      '# Keywords',
      '- oauth',
    ].join('\n'));

    expect(parsed.kind).toBe('search');
    expect(parsed.data.files).toEqual(['src/auth/index.ts']);
    expect(parsed.data.functions).toEqual(['login()']);
  });

  it('infers conservative kinds from intent and goal', () => {
    expect(inferKindFromIntent('test', 'verification', 'use background analysis for test coverage')).toBe('test_analysis');
    expect(inferKindFromIntent('test', 'verification', 'fix failing tests')).toBeNull();
    expect(inferKindFromIntent('refactor', 'context', 'rename addOne to increment')).toBeNull();
    expect(inferKindFromIntent('debug', 'context', 'fix greeting output')).toBeNull();
    expect(inferKindFromIntent('edit', 'context', 'use background analysis to inspect OAuth flow before editing')).toBe('explorer');
    expect(inferKindFromIntent('inspect', 'context', 'understand module')).toBe('explorer');
    expect(inferKindFromIntent('question', 'intent', 'hello')).toBeNull();
  });
});
