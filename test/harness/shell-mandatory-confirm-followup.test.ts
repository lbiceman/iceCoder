import { describe, expect, it } from 'vitest';

import { extractRunCommand } from '../../src/harness/branch-budget-tool-path.js';
import { checkToolPreflight } from '../../src/harness/harness-tool-preflight.js';

describe('extractRunCommand', () => {
  it('accepts command and cmd alias', () => {
    expect(extractRunCommand({ command: 'npm test' })).toBe('npm test');
    expect(extractRunCommand({ cmd: 'npm test' })).toBe('npm test');
    expect(extractRunCommand({ action: 'check', task_id: 'x' })).toBeUndefined();
  });
});

describe('checkToolPreflight shell hard block reason', () => {
  it('maps catastrophic run_command to shell_hard_block', () => {
    const decision = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'rm -rf /' },
      workspaceRoot: '/tmp/workspace',
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('shell_hard_block');
  });
});
