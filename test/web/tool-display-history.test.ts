import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadToolDisplayHistory() {
  const diffSrc = readFileSync(
    path.join(__dirname, '../../src/public/js/diff-viewer.js'),
    'utf-8',
  );
  const src = readFileSync(
    path.join(__dirname, '../../src/public/js/tool-display-history.js'),
    'utf-8',
  );
  const ctx: { DiffViewer?: unknown; window: Record<string, unknown> } = { window: {} };
  runInNewContext(diffSrc, ctx);
  ctx.window.DiffViewer = ctx.DiffViewer;
  runInNewContext(src, ctx);
  return ctx.window.ToolDisplayHistory as {
    buildAgentDisplayMap: (
      structured: unknown[],
      uiMessages: { id: string }[],
      toolTraces: Record<string, { toolName: string; toolCallId?: string }[]>,
    ) => Record<string, { toolCallId: string; toolName: string; diffSource: string | null }[]>;
  };
}

describe('tool-display-history buildAgentDisplayMap', () => {
  it('aligns multiple structured tool rounds to one agent message traces', () => {
    const TDH = loadToolDisplayHistory();
    const patchA = '@@ -1 +1 @@\n+a';
    const patchB = '@@ -2 +2 @@\n+b';
    const structured = [
      {
        role: 'assistant',
        toolCalls: [
          { id: 'call_a', name: 'patch_file', arguments: { patch: patchA } },
        ],
      },
      { role: 'tool', toolCallId: 'call_a', content: 'applied' },
      {
        role: 'assistant',
        toolCalls: [
          { id: 'call_b', name: 'patch_file', arguments: { patch: patchB } },
        ],
      },
      { role: 'tool', toolCallId: 'call_b', content: 'applied' },
    ];
    const agentId = 'agent-1';
    const uiMessages = [{ id: agentId, role: 'agent', content: 'done' }];
    const toolTraces = {
      [agentId]: [
        { toolName: 'patch_file', toolCallId: 'call_a' },
        { toolName: 'patch_file', toolCallId: 'call_b' },
      ],
    };

    const map = TDH.buildAgentDisplayMap(structured, uiMessages, toolTraces);
    expect(map[agentId]).toHaveLength(2);
    expect(map[agentId][0].diffSource).toBe(patchA);
    expect(map[agentId][1].diffSource).toBe(patchB);
  });

  it('falls back to order when toolCallId missing on trace', () => {
    const TDH = loadToolDisplayHistory();
    const patch = '@@ -1 +1 @@\n+x';
    const structured = [
      {
        role: 'assistant',
        toolCalls: [{ id: 'c1', name: 'patch_file', arguments: { patch } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
    ];
    const agentId = 'agent-2';
    const map = TDH.buildAgentDisplayMap(
      structured,
      [{ id: agentId }],
      { [agentId]: [{ toolName: 'patch_file' }] },
    );
    expect(map[agentId][0].diffSource).toBe(patch);
  });
});
