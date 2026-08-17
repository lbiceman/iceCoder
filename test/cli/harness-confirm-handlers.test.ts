import { describe, expect, it, vi } from 'vitest';

import {
  createCliOnConfirm,
  createCliOnShellMandatoryConfirm,
} from '../../src/cli/utils/harness-confirm-handlers.js';
import type { ShellMandatoryConfirmRequest } from '../../src/harness/harness-permission-runtime.js';

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb('y'),
    close: () => {},
  }),
}));

describe('cli harness confirm handlers', () => {
  it('createCliOnConfirm resolves yes from terminal prompt', async () => {
    const spinner = { stop: vi.fn() };
    const onConfirm = createCliOnConfirm(spinner);
    await expect(onConfirm('delete_file', { path: 'x.txt' })).resolves.toBe(true);
    expect(spinner.stop).toHaveBeenCalledTimes(1);
  });

  it('createCliOnShellMandatoryConfirm resolves yes from terminal prompt', async () => {
    const spinner = { stop: vi.fn() };
    const onShellMandatoryConfirm = createCliOnShellMandatoryConfirm(spinner);
    const request = {
      toolName: 'run_command',
      args: { command: 'git reset --hard' },
      command: 'git reset --hard',
      commandDisplay: 'git reset --hard',
      taskId: '__run_command__',
      sessionId: 'sess-1',
      normalizedCommandHash: 'abc',
      risk: {
        risk: 'mandatory_confirm' as const,
        matchedPattern: 'git\\s+reset\\s+--hard',
        category: 'Git',
        impact: 'Discards local changes',
        normalized: 'git reset --hard',
      },
    } satisfies ShellMandatoryConfirmRequest;

    await expect(onShellMandatoryConfirm(request)).resolves.toBe(true);
    expect(spinner.stop).toHaveBeenCalledTimes(1);
  });
});
