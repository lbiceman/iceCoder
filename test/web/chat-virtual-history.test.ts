import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadChatVirtualHistory() {
  const src = readFileSync(
    path.join(__dirname, '../../src/public/js/chat-virtual-history.js'),
    'utf-8',
  );
  const ctx: { window: Record<string, unknown> } = { window: {} };
  runInNewContext(src, ctx);
  return ctx.window.ChatVirtualHistory as {
    TAIL_TURN_COUNT: number;
    estimateUnitHeight: (unit: { type: string; traces?: unknown[]; msg?: { content?: string } }) => number;
    clampIndexRange: (
      range: { start: number; end: number } | null,
      length: number,
    ) => { start: number; end: number } | null;
    computeTailStartIndex: (messages: { role: string }[], n?: number) => number;
    buildHistoryUnits: (
      messages: { role: string; id?: string }[],
      toolTraces: Record<string, unknown[]>,
      displayMap: Record<string, unknown[]>,
      tailStart: number,
    ) => { type: string; key: string }[];
  };
}

describe('ChatVirtualHistory', () => {
  it('keeps last two user turns in tail (real DOM zone)', () => {
    const CVH = loadChatVirtualHistory();
    const messages = [
      { role: 'user', id: 'u1' },
      { role: 'agent', id: 'a1' },
      { role: 'user', id: 'u2' },
      { role: 'agent', id: 'a2' },
      { role: 'user', id: 'u3' },
      { role: 'agent', id: 'a3' },
    ];
    expect(CVH.computeTailStartIndex(messages, 2)).toBe(2);
    const units = CVH.buildHistoryUnits(messages, {}, {}, 2);
    expect(units.some((u) => u.key === 'msg:u1:user')).toBe(true);
    expect(units.some((u) => u.key === 'msg:u3:user')).toBe(false);
  });

  it('estimates tools group height from visible rows only (not full trace count)', () => {
    const CVH = loadChatVirtualHistory();
    const many = { type: 'tools', key: 'tools:x', traces: new Array(120).fill({ toolName: 'write_file' }) };
    const alsoCollapsed = { type: 'tools', key: 'tools:y', traces: new Array(4).fill({ toolName: 'write_file' }) };
    expect(CVH.estimateUnitHeight(many)).toBeLessThan(200);
    expect(CVH.estimateUnitHeight(many)).toBe(CVH.estimateUnitHeight(alsoCollapsed));
    expect(CVH.estimateUnitHeight(many)).toBeLessThan(120 * 36);
  });

  it('puts all messages in tail when fewer than two user turns', () => {
    const CVH = loadChatVirtualHistory();
    const messages = [
      { role: 'user', id: 'u1' },
      { role: 'agent', id: 'a1' },
    ];
    expect(CVH.computeTailStartIndex(messages, 2)).toBe(0);
    expect(CVH.buildHistoryUnits(messages, {}, {}, 0)).toHaveLength(0);
  });

  it('clampIndexRange 丢弃越界或空列表范围', () => {
    const CVH = loadChatVirtualHistory();
    expect(CVH.clampIndexRange({ start: 10, end: 20 }, 0)).toBeNull();
    expect(CVH.clampIndexRange({ start: 10, end: 20 }, 3)).toBeNull();
    expect(CVH.clampIndexRange({ start: 0, end: 20 }, 3)).toEqual({ start: 0, end: 2 });
    expect(CVH.clampIndexRange({ start: 1, end: 1 }, 3)).toEqual({ start: 1, end: 1 });
  });
});
