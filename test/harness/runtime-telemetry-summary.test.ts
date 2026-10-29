import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deriveToolResultBudget,
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
    expect(summary.failures).toBe(0);
    expect(summary.permissionDecisions).toEqual({ allow: 1, deny: 1 });

    const report = formatRuntimeTelemetryMarkdown(summary);
    expect(report).toContain('Runtime Telemetry Report');
    expect(report).toContain('no_tool_final_rate: 0.5');
  });

  it('aggregates tool result shaping, range errors, pressure clears and rereads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-telemetry-'));
    const file = path.join(dir, 'telemetry.jsonl');
    const timestamp = new Date().toISOString();

    await fs.writeFile(file, [
      JSON.stringify({ type: 'tool_result_budget', timestamp, sessionId: 'a', round: 1, toolName: 'read_file', toolCallId: 't1', strategy: 'page', originalChars: 80_000, originalTokens: 20_000, injectedChars: 32_000, injectedTokens: 8_000, capTokens: 8_000, capSource: 'tier', path: 'tokens.css', omittedLines: [[301, 900]], spilled: false }),
      JSON.stringify({ type: 'tool_result_budget', timestamp, sessionId: 'a', round: 2, toolName: 'read_file', toolCallId: 't2', strategy: 'range_error', originalChars: 0, originalTokens: 30_000, injectedChars: 200, injectedTokens: 50, capTokens: 8_000, capSource: 'tier', spilled: false }),
      JSON.stringify({ type: 'tool_result_reread', timestamp, sessionId: 'a', round: 3, toolCallId: 't3', rereadOf: 't1', reason: 'paged', path: 'tokens.css', lines: [301, 600], injectedTokens: 7_000 }),
      JSON.stringify({ type: 'tool_result_clear', timestamp, sessionId: 'b', cleared: 2, clearedTokens: 1_500, toolCallIds: ['x', 'y'] }),
    ].join('\n'), 'utf-8');

    const summary = await summarizeRuntimeTelemetry(file, { days: 7 });

    expect(summary.toolResultBudget).toMatchObject({
      shapedResults: 1,
      shapedSavedTokens: 12_000,
      rangeErrors: 1,
      clearedResults: 2,
      clearedTokens: 1_500,
      rereads: 1,
      rereadTokens: 7_000,
      measuredCalls: 0,
      budgetOverflows: 0,
    });
    expect(formatRuntimeTelemetryMarkdown(summary)).toContain('## Tool Result Budget');
  });

  it('accumulates per-call savings against reread cost and pre-send budget checks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-telemetry-'));
    const file = path.join(dir, 'telemetry.jsonl');
    const timestamp = new Date().toISOString();
    const savings = (round: number, shaped: number, cleared: number, reread: number) => JSON.stringify({
      type: 'tool_result_savings', timestamp, sessionId: 'a', round,
      shapedSavedTokens: shaped, clearedSavedTokens: cleared, rereadTokens: reread,
      shapedResults: 1, clearedResults: cleared ? 1 : 0, rereadResults: reread ? 1 : 0,
    });

    await fs.writeFile(file, [
      savings(1, 1_000, 0, 0),
      savings(2, 1_000, 500, 0),
      savings(3, 1_000, 500, 800),
      JSON.stringify({ type: 'tool_result_reread', timestamp, sessionId: 'a', round: 3, toolCallId: 't3', rereadOf: 't1', reason: 'spill', path: '/s/t1.log', injectedTokens: 800 }),
      JSON.stringify({ type: 'context_budget', timestamp, sessionId: 'a', round: 4, totalTokens: 120_000, limitTokens: 111_616, shrunkResults: 2, shrunkTokens: 9_000, overflowTokens: 0 }),
      JSON.stringify({ type: 'context_budget', timestamp, sessionId: 'a', round: 5, totalTokens: 130_000, limitTokens: 111_616, shrunkResults: 0, shrunkTokens: 0, overflowTokens: 4_000 }),
    ].join('\n'), 'utf-8');

    const summary = await summarizeRuntimeTelemetry(file, { days: 7 });
    expect(summary.toolResultBudget).toMatchObject({
      measuredCalls: 3,
      cumulativeSavedTokens: 4_000,
      cumulativeRereadTokens: 800,
      rereads: 1,
      budgetShrunkResults: 2,
      budgetShrunkTokens: 9_000,
      budgetOverflows: 1,
      budgetOverflowTokens: 4_000,
    });
    expect(deriveToolResultBudget(summary.toolResultBudget)).toEqual({ netSavedTokens: 3_200, rereadsPer1kSaved: 0.25 });
    const report = formatRuntimeTelemetryMarkdown(summary);
    expect(report).toContain('net_saved_tokens: 3200');
    expect(report).toContain('rereads_per_1k_saved: 0.25');
    expect(report).toContain('budget_overflows: 1');
  });
});
