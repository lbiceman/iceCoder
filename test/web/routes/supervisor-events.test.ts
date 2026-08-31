import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractExecutionModeEvents,
  readJsonlFile,
} from '../../../src/web/routes/supervisor-events.js';

describe('execution-mode telemetry API helpers', () => {
  it('reads recent JSONL records and ignores corrupt lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-mode-events-'));
    const file = path.join(dir, 'telemetry.jsonl');
    await fs.writeFile(file, [
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'execution_mode_enter', round: 2 }),
      '{broken',
    ].join('\n'));
    expect(await readJsonlFile(file, 7)).toHaveLength(1);
  });

  it('extracts only execution-mode events', () => {
    const events = extractExecutionModeEvents([
      {
        timestamp: new Date().toISOString(),
        type: 'execution_mode_enter',
        executionMode: 'forced',
        round: 3,
        enteredBy: ['tool_failure'],
        primaryReasonHuman: '工具失败',
      },
      { type: 'other' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.executionMode).toBe('forced');
  });
});
