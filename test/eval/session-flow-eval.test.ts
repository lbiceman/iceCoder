import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSessionFlowEval } from '../../scripts/session-flow-eval-runner.js';

describe('session-flow-eval', () => {
  it('covers deletion, /also, /next, ordering, and session isolation', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-session-flow-eval-test-'));
    try {
      const report = await runSessionFlowEval({ workspaceRoot: workspace });

      expect(report.caseCount).toBeGreaterThanOrEqual(6);
      expect(report.passRate).toBe(1);
      expect(report.results.every((result) => result.passed)).toBe(true);
      expect(report.results.map((result) => result.id)).toEqual(expect.arrayContaining([
        'delete-single-middle-message',
        'delete-missing-message-is-noop',
        'also-active-run-injection',
        'also-run-and-session-isolation',
        'next-explicit-fifo-persistence',
        'task-queue-session-isolation',
      ]));
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
