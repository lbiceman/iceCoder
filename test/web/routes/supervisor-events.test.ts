import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSupervisorEventsReport,
  filterSupervisorTimelineEvents,
  extractExecutionModeEvents,
  readJsonlFile,
} from '../../../src/web/routes/supervisor-events.js';

describe('supervisor-events API helpers', () => {
  it('filters timeline events and formats report', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-events-'));
    const supervisorLog = path.join(dir, 'supervisor-events.jsonl');
    const runtimeLog = path.join(dir, 'telemetry.jsonl');

    await fs.writeFile(supervisorLog, [
      JSON.stringify({
        ts: Date.now(),
        round: 2,
        mode: 'adaptive',
        event: 'recover',
        reason: 'graph_hint:evaluate_round',
      }),
      JSON.stringify({
        ts: Date.now(),
        round: 3,
        mode: 'strict',
        event: 'failure',
        reason: 'correction_budget_exhausted:recovery',
      }),
    ].join('\n'), 'utf-8');

    await fs.writeFile(runtimeLog, [
      JSON.stringify({
        type: 'execution_mode_enter',
        timestamp: new Date().toISOString(),
        executionMode: 'forced',
        enteredBy: ['checkpoint_resumed', 'pending_steps'],
        enteredByPrimary: 'checkpoint_resumed',
        primaryReasonHuman: 'forced because checkpoint_resumed + pending_steps',
        round: 1,
      }),
    ].join('\n'), 'utf-8');

    const { report, timelineEvents, executionModeEvents } = await buildSupervisorEventsReport(
      { days: 7, limit: 5 },
      { supervisorLog, runtimeLog },
    );

    expect(timelineEvents).toHaveLength(2);
    expect(executionModeEvents).toHaveLength(1);
    expect(report).toContain('Supervisor 事件报告');
    expect(report).toContain('forced because checkpoint_resumed + pending_steps');
    expect(report).toContain('recover');
  });

  it('supports event filter on timeline', async () => {
    const entries = await readJsonlFile('__nonexistent__', 7);
    expect(entries).toEqual([]);

    const filtered = filterSupervisorTimelineEvents([
      { ts: 1, round: 1, mode: 'adaptive', event: 'recover', reason: 'a' },
      { ts: 2, round: 2, mode: 'adaptive', event: 'failure', reason: 'b' },
    ], 'recover');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.event).toBe('recover');
  });

  it('extracts execution mode enter/exit from runtime telemetry lines', () => {
    const events = extractExecutionModeEvents([
      {
        type: 'execution_mode_enter',
        timestamp: '2026-05-21T08:00:00.000Z',
        executionMode: 'forced',
        enteredBy: ['explicit_impl'],
        enteredByPrimary: 'explicit_impl',
        primaryReasonHuman: 'forced because explicit_impl',
        round: 1,
        degradedTier: 'graph',
      },
    ]);
    expect(events[0]?.payload.degradedTier).toBe('graph');
    expect(events[0]?.payload.primaryReasonHuman).toContain('explicit_impl');
  });
});
