import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatRuntimeTelemetryMarkdown,
  summarizeRuntimeTelemetry,
} from '../../src/harness/runtime-telemetry-summary.js';

describe('runtime telemetry summary', () => {
  it('aggregates cross-session runtime metrics without double counting compaction tokens', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-telemetry-'));
    const file = path.join(dir, 'telemetry.jsonl');
    const timestamp = new Date().toISOString();

    await fs.writeFile(file, [
      JSON.stringify({ type: 'round', timestamp, sessionId: 'a', round: 1, task: {}, repo: {} }),
      JSON.stringify({ type: 'tool', timestamp, sessionId: 'a', round: 1, toolName: 'ReadFile', success: true, permission: 'allow' }),
      JSON.stringify({ type: 'tool', timestamp, sessionId: 'a', round: 1, toolName: 'Shell', success: false, permission: 'deny' }),
      JSON.stringify({ type: 'compaction', timestamp, sessionId: 'a', beforeMessages: 10, afterMessages: 4, beforeTokens: 1000, afterTokens: 400, savedTokens: 600 }),
      JSON.stringify({ type: 'summary', timestamp, sessionId: 'a', task: {}, repo: {}, rounds: 1, toolCalls: 2, verificationRate: 1, noToolFinal: false, tokensPerSuccessfulTask: 1200, compactionSavedTokens: 600 }),
      JSON.stringify({ type: 'summary', timestamp, sessionId: 'b', task: {}, repo: {}, rounds: 0, toolCalls: 0, verificationRate: 0, noToolFinal: true, compactionSavedTokens: 0 }),
      JSON.stringify({ type: 'host_guard_block', timestamp, sessionId: 'b', round: 1, toolName: 'Shell', source: 'preflight' }),
      '{bad json',
    ].join('\n'), 'utf-8');

    const summary = await summarizeRuntimeTelemetry(file, {
      days: 7,
      generatedAt: '2026-07-09T00:00:00.000Z',
    });

    expect(summary.eventsRead).toBe(7);
    expect(summary.sessions).toBe(2);
    expect(summary.rounds).toBe(1);
    expect(summary.toolCalls).toBe(2);
    expect(summary.failedToolCalls).toBe(1);
    expect(summary.verificationRate).toBe(0.5);
    expect(summary.noToolFinalRate).toBe(0.5);
    expect(summary.compactionSavedTokens).toBe(600);
    expect(summary.hostGuardBlocks).toBe(1);
    expect(summary.permissionDecisions).toEqual({ allow: 1, deny: 1 });

    const report = formatRuntimeTelemetryMarkdown(summary);
    expect(report).toContain('Runtime Telemetry Report');
    expect(report).toContain('no_tool_final_rate: 0.5');
  });
});
