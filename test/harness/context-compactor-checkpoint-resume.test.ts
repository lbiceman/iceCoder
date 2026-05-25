import { describe, expect, it } from 'vitest';

import { buildCheckpointResumeSummary } from '../../src/harness/checkpoint-resume-compact.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('ContextCompactor.compactForCheckpointResume', () => {
  it('keeps system, anchor, resume summary, and trims recent tail', () => {
    const anchor = 'Implement survivors benchmark with npm test acceptance gate'.padEnd(90, '.');
    const resumeSummary = {
      role: 'user' as const,
      content: buildCheckpointResumeSummary({
        version: 1,
        taskId: 't1',
        status: 'paused',
        userGoal: 'continue',
        phase: 'verification',
        taskState: {
          goal: anchor,
          intent: 'edit',
          phase: 'verification',
          filesRead: [],
          filesChanged: ['src/a.ts'],
          commandsRun: ['npm test'],
          verificationRequired: true,
          verificationStatus: 'failed',
        },
        repoContext: {
          filesRead: [],
          filesChanged: ['src/a.ts'],
          commandsRun: ['npm test'],
          testCommands: ['npm test'],
          recentDiagnostics: ['failed'],
        },
        failedToolCalls: [],
        messageCount: 10,
        loop: {
          currentRound: 5,
          totalToolCalls: 2,
          totalInputTokens: 10,
          totalOutputTokens: 5,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      preserveOnCompaction: true,
    };

    const input: UnifiedMessage[] = [{ role: 'system', content: 'sys' }];
    input.push({ role: 'user', content: anchor });
    for (let i = 0; i < 50; i++) {
      input.push(
        { role: 'user', content: `turn ${i} ${'z'.repeat(200)}` },
        { role: 'assistant', content: `reply ${i} ${'y'.repeat(200)}` },
      );
    }

    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 10,
      keepRecentMinTokens: 50,
      keepRecentMaxTokens: 20_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
      maxToolResultLength: 300,
    });

    const before = compactor.getEstimatedTokens(input);
    const result = compactor.compactForCheckpointResume(input, resumeSummary, { maxRecentMessages: 12 });
    const after = compactor.getEstimatedTokens(result);

    expect(result.length).toBeLessThan(input.length);
    expect(after).toBeLessThan(before);
    expect(result[0]?.role).toBe('system');
    expect(result.some(m => typeof m.content === 'string' && m.content.includes(anchor.slice(0, 30)))).toBe(true);
    expect(result.filter(m => typeof m.content === 'string' && m.content.startsWith('<resume-checkpoint>'))).toHaveLength(1);
  });

  it('aggressive mode produces smaller output than normal fork', () => {
    const anchor = 'Implement survivors benchmark with npm test acceptance gate'.padEnd(90, '.');
    const resumeSummary = {
      role: 'user' as const,
      content: '<resume-checkpoint>\nphase: verification\n</resume-checkpoint>',
      preserveOnCompaction: true,
    };
    const input: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: anchor },
    ];
    for (let i = 0; i < 80; i++) {
      input.push(
        { role: 'assistant', content: '', toolCalls: [{ id: `tc-${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }] },
        { role: 'tool', toolCallId: `tc-${i}`, content: 'body '.repeat(300) },
      );
    }

    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 20,
      keepRecentMinTokens: 50,
      keepRecentMaxTokens: 20_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
      maxToolResultLength: 400,
    });

    const normal = compactor.compactForCheckpointResume(input, resumeSummary, { aggressive: false });
    const aggressive = compactor.compactForCheckpointResume(input, resumeSummary, { aggressive: true });

    expect(compactor.getEstimatedTokens(aggressive)).toBeLessThanOrEqual(compactor.getEstimatedTokens(normal));
    expect(aggressive.length).toBeLessThanOrEqual(normal.length);
  });
});
