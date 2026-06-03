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
    buildToolCallDiffIndex: (structured: unknown[]) => Record<string, string>;
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

  it('prefers diffSource persisted on tool_trace over structured alignment', () => {
    const TDH = loadToolDisplayHistory();
    const persisted = '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new';
    const structured = [
      {
        role: 'assistant',
        toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'File modified (no diff in structured)' },
    ];
    const agentId = 'agent-3';
    const map = TDH.buildAgentDisplayMap(
      structured,
      [{ id: agentId }],
      { [agentId]: [{ toolName: 'edit_file', toolCallId: 'c1', diffSource: persisted }] },
    );
    expect(map[agentId][0].diffSource).toBe(persisted);
  });

  it('aligns write_file when UI traces include fs_operation not in structured', () => {
    const TDH = loadToolDisplayHistory() as {
      alignAgentTracesToOutputs: (
        traces: { toolName: string; toolCallId?: string }[],
        structured: unknown[],
        flatOffset: number,
      ) => { diffSource: string | null }[];
    };
    const diffW1 = '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n+w1\n';
    const diffW2 = '--- b.txt\n+++ b.txt\n@@ -1 +1 @@\n+w2\n';
    const diffRun = '--- x.ps1\n+++ x.ps1\n@@ -1 +1 @@\n+cmd\n';
    const structured = [
      {
        role: 'assistant',
        toolCalls: [
          { id: 'w1', name: 'write_file', arguments: { path: 'a.txt' } },
          { id: 'w2', name: 'write_file', arguments: { path: 'b.txt' } },
          { id: 'r1', name: 'run_command', arguments: {} },
        ],
      },
      { role: 'tool', toolCallId: 'w1', content: 'File written: a.txt\n\n' + diffW1 },
      { role: 'tool', toolCallId: 'w2', content: 'File written: b.txt\n\n' + diffW2 },
      { role: 'tool', toolCallId: 'r1', content: diffRun },
    ];
    const traces = [
      { toolName: 'fs_operation', toolCallId: 'fs1' },
      { toolName: 'fs_operation', toolCallId: 'fs2' },
      { toolName: 'write_file', toolCallId: 'w1' },
      { toolName: 'write_file', toolCallId: 'w2' },
      { toolName: 'run_command', toolCallId: 'r1' },
    ];
    const aligned = TDH.alignAgentTracesToOutputs(traces, structured, 0);
    expect(aligned[2].diffSource).toContain('w1');
    expect(aligned[3].diffSource).toContain('w2');
    expect(aligned[4].diffSource).toContain('cmd');
  });

  it('keeps trace toolCallId on display map entries (does not swap to structured id)', () => {
    const TDH = loadToolDisplayHistory() as {
      alignAgentTracesToOutputs: (
        traces: { toolName: string; toolCallId: string }[],
        structured: unknown[],
        flatOffset: number,
      ) => { toolCallId: string; diffSource: string | null }[];
    };
    const diff = '--- a.txt\n+++ a.txt\n@@\n+x\n';
    const structured = [
      {
        role: 'assistant',
        toolCalls: [{ id: 'structured_id_only', name: 'write_file', arguments: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 'structured_id_only', content: 'File written: a.txt\n\n' + diff },
    ];
    const traces = [{ toolName: 'write_file', toolCallId: 'trace_id_on_ui' }];
    const aligned = TDH.alignAgentTracesToOutputs(traces, structured, 0);
    expect(aligned[0].toolCallId).toBe('trace_id_on_ui');
    expect(aligned[0].diffSource).toContain('+x');
  });

  it('aligns write_file traces by order when toolCallId is duplicated on traces', () => {
    const TDH = loadToolDisplayHistory();
    const diff1 = '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n+a\n';
    const diff2 = '--- b.txt\n+++ b.txt\n@@ -1 +1 @@\n+b\n';
    const structured = [
      {
        role: 'assistant',
        toolCalls: [
          { id: 'dup_id', name: 'write_file', arguments: { path: 'a.txt' } },
          { id: 'dup_id', name: 'write_file', arguments: { path: 'b.txt' } },
        ],
      },
      { role: 'tool', toolCallId: 'dup_id', content: 'File written: a.txt\n\n' + diff1 },
      { role: 'tool', toolCallId: 'dup_id', content: 'File written: b.txt\n\n' + diff2 },
    ];
    const agentId = 'agent-wf';
    const map = TDH.buildAgentDisplayMap(
      structured,
      [{ id: agentId }],
      {
        [agentId]: [
          { toolName: 'write_file', toolCallId: 'dup_id' },
          { toolName: 'write_file', toolCallId: 'dup_id' },
        ],
      },
    );
    expect(map[agentId][0].diffSource).toContain('+a');
    expect(map[agentId][1].diffSource).toContain('+b');
  });

  it('extractDiffSource pulls unified diff from write_file tool output', () => {
    const TDH = loadToolDisplayHistory() as {
      extractDiffSource: (name: string, output: string, args?: unknown) => string | null;
    };
    const diff = '--- a.txt\n+++ a.txt\n@@ -1,2 +1,3 @@\n line\n+new\n';
    const output = 'File written: a.txt\n\n' + diff;
    const got = TDH.extractDiffSource('write_file', output, undefined);
    expect(got).toContain('+new');
  });

  it('buildToolCallDiffIndex maps toolCallId to diff regardless of trace order', () => {
    const TDH = loadToolDisplayHistory();
    const diff = '--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b';
    const structured = [
      {
        role: 'assistant',
        toolCalls: [
          { id: 'call_1', name: 'edit_file', arguments: { path: 'a.ts' } },
          { id: 'call_2', name: 'edit_file', arguments: { path: 'b.ts' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'File modified: a.ts\n\n' + diff },
      { role: 'tool', toolCallId: 'call_2', content: 'ok only' },
    ];
    const index = TDH.buildToolCallDiffIndex(structured);
    expect(index.call_1).toContain('+b');
    expect(index.call_2).toBeUndefined();
  });
});
