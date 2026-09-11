import { describe, expect, it } from 'vitest';

import { countModeEscalatingFailures } from '../../src/harness/harness-tool-round.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import type { ToolCall } from '../../src/llm/types.js';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

describe('execution mode escalation signals', () => {
  it('keeps a normal two-file edit below the default multi-write threshold', () => {
    expect(defaultSupervisorConfig().executionMode?.writeTargetsEnterThreshold).toBe(2);
  });

  it('does not treat a failed verification command as a forced-entry tool failure', () => {
    const verification = call('verify', 'run_command', { command: 'npm test' });
    const edit = call('edit', 'edit_file', { path: 'src/a.ts' });

    expect(countModeEscalatingFailures(
      [verification],
      new Set([toolCallSignature(verification)]),
    )).toBe(0);

    expect(countModeEscalatingFailures(
      [verification, edit],
      new Set([toolCallSignature(verification), toolCallSignature(edit)]),
    )).toBe(1);
  });

  it('does not treat a failed acceptance command as a forced-entry tool failure', () => {
    const acceptance = call('build', 'run_command', { command: 'npm run build' });
    const signature = toolCallSignature(acceptance);

    expect(countModeEscalatingFailures(
      [acceptance],
      new Set([signature]),
      new Set([signature]),
    )).toBe(0);
  });
});
