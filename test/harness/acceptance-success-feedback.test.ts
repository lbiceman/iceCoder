import { describe, expect, it } from 'vitest';

import { buildAcceptanceSuccessFeedbackMessage } from '../../src/harness/harness-tool-round.js';

describe('buildAcceptanceSuccessFeedbackMessage', () => {
  it('returns null when nothing changed', () => {
    expect(
      buildAcceptanceSuccessFeedbackMessage({
        newlyPassed: [],
        completedAll: false,
        passedCount: 0,
        totalCount: 4,
      }),
    ).toBeNull();
  });

  it('emits a single ✓ line for one newly-passed command', () => {
    const msg = buildAcceptanceSuccessFeedbackMessage({
      newlyPassed: [{ command: 'npm test', summary: '8 files / 22 tests passed' }],
      completedAll: false,
      passedCount: 1,
      totalCount: 4,
    });
    expect(msg).toContain('[System / Acceptance ✓] npm test');
    expect(msg).toContain('8 files / 22 tests passed');
    expect(msg).toContain('(1/4 passed)');
    // 单条 passed 时不应出现 stopping signal
    expect(msg).not.toMatch(/STOP calling tools/);
    expect(msg).not.toMatch(/All \d+ acceptance commands passed/);
  });

  it('appends stopping signal when all commands pass', () => {
    const msg = buildAcceptanceSuccessFeedbackMessage({
      newlyPassed: [{ command: 'npm run test:e2e', summary: '5 e2e tests passed in 4.4s' }],
      completedAll: true,
      passedCount: 4,
      totalCount: 4,
    });
    expect(msg).toContain('[System / Acceptance ✓] npm run test:e2e — 5 e2e tests passed in 4.4s (4/4 passed)');
    expect(msg).toContain('[System / Acceptance ✓] All 4 acceptance commands passed.');
    expect(msg).toContain('Output ≤10 delivery bullets now and STOP calling tools.');
    expect(msg).toMatch(/the task is complete/);
  });

  it('handles missing summary (falls back to bare ✓ line)', () => {
    const msg = buildAcceptanceSuccessFeedbackMessage({
      newlyPassed: [{ command: 'npm ci', summary: null }],
      completedAll: false,
      passedCount: 2,
      totalCount: 4,
    });
    expect(msg).toContain('[System / Acceptance ✓] npm ci (2/4 passed)');
    // 没有 summary 时不会插入「 — 」
    expect(msg).not.toMatch(/ — null/);
    expect(msg).not.toMatch(/—\s+\(/);
  });

  it('truncates very long command labels to ≤80 chars + ellipsis', () => {
    const longCmd = `npm run ${'really-long-script-name-'.repeat(8)}`;
    const msg = buildAcceptanceSuccessFeedbackMessage({
      newlyPassed: [{ command: longCmd, summary: 'ok' }],
      completedAll: false,
      passedCount: 1,
      totalCount: 4,
    });
    expect(msg).toMatch(/\.\.\./);
    const firstLine = msg!.split('\n')[0];
    // `[System / Acceptance ✓] ` 23 chars + 80 cmd cap + ` — ok (1/4 passed)` ≈ 121 chars
    expect(firstLine.length).toBeLessThan(140);
  });

  it('emits multiple ✓ lines when several commands pass in one round', () => {
    const msg = buildAcceptanceSuccessFeedbackMessage({
      newlyPassed: [
        { command: 'npm test', summary: '22 tests passed' },
        { command: 'npm run build', summary: 'build succeeded in 7s' },
      ],
      completedAll: false,
      passedCount: 3,
      totalCount: 4,
    });
    const lines = msg!.split('\n').filter(l => l.startsWith('[System / Acceptance ✓]'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('npm test');
    expect(lines[0]).toContain('(2/4 passed)');
    expect(lines[1]).toContain('npm run build');
    expect(lines[1]).toContain('(3/4 passed)');
  });

  it('returns stopping signal alone when completedAll fires with no fresh newlyPassed', () => {
    // 边界：所有命令在更早轮次就 passed，本轮无新增但 isComplete() 第一次返回 true
    // （理论上应不会发生，因为状态转换发生在 newlyPassed 之时；测一下兜底行为）
    const msg = buildAcceptanceSuccessFeedbackMessage({
      newlyPassed: [],
      completedAll: true,
      passedCount: 4,
      totalCount: 4,
    });
    expect(msg).toContain('All 4 acceptance commands passed.');
    expect(msg).toContain('STOP calling tools');
  });
});
