import { describe, expect, it } from 'vitest';

import {
  normalizeOperationOutcome,
  OperationOutcomeLedger,
} from '../../src/harness/operation-outcome.js';

describe('operation outcome normalization', () => {
  it('treats read-only tools as settled observations', () => {
    const outcome = normalizeOperationOutcome(
      { id: 'r1', name: 'read_file', arguments: { path: 'README.md' } },
      { success: true, output: '# Project' },
    );

    expect(outcome.status).toBe('completed');
    expect(outcome.effect).toBe('observe');
    expect(outcome.risk).toBe('low');
    expect(outcome.reversibility).toBe('reversible');
  });

  it('uses a successful local write result as a receipt', () => {
    const outcome = normalizeOperationOutcome(
      { id: 'w1', name: 'write_file', arguments: { path: 'notes.txt' } },
      { success: true, output: 'File written' },
    );

    expect(outcome.effect).toBe('local_change');
    expect(outcome.reversibility).toBe('reversible');
    expect(outcome.receipt?.target).toBe('notes.txt');
    expect(outcome.receipt?.summary).toBe('File written');
  });

  it('keeps a background shell operation pending until its task completes', () => {
    const ledger = new OperationOutcomeLedger();
    ledger.record(normalizeOperationOutcome(
      { id: 's1', name: 'run_command', arguments: { command: 'make all' } },
      {
        success: true,
        output: JSON.stringify({ mode: 'background', status: 'started', taskId: 'bg_1' }),
      },
    ));
    expect(ledger.hasPending()).toBe(true);

    ledger.record(normalizeOperationOutcome(
      { id: 's2', name: 'run_command', arguments: { action: 'check', task_id: 'bg_1' } },
      {
        success: true,
        output: JSON.stringify({ status: 'completed', taskId: 'bg_1', exitCode: 0 }),
      },
    ));
    expect(ledger.hasPending()).toBe(false);
  });

  it('treats a detached background launch as a settled launch receipt', () => {
    const outcome = normalizeOperationOutcome(
      { id: 'a1', name: 'request_analysis', arguments: { task: 'inspect' } },
      {
        success: true,
        output: 'taskId: asa_1\nstatus: pending\nlifespan: detached\nrunning in the background',
      },
    );

    expect(outcome.status).toBe('completed');
  });

  it('recognizes approval waits and destructive operations without tool-name gates', () => {
    const approval = normalizeOperationOutcome(
      { id: 'a1', name: 'remote_action', arguments: {} },
      {
        success: false,
        status: 'awaiting_approval',
        effect: 'external_change',
        risk: 'high',
        output: 'approval required',
      },
    );
    const destructive = normalizeOperationOutcome(
      { id: 'd1', name: 'fs_operation', arguments: { operation: 'delete', path: 'old.tmp' } },
      { success: true, output: '' },
    );

    expect(approval.status).toBe('awaiting_approval');
    expect(approval.effect).toBe('external_change');
    expect(approval.reversibility).toBe('irreversible');
    expect(destructive.risk).toBe('high');
    expect(destructive.reversibility).toBe('compensatable');
    expect(destructive.receipt?.target).toBe('old.tmp');
    expect(destructive.receipt?.summary).toBeUndefined();
  });

  it('replaces and restores deep-copied outcomes idempotently', () => {
    const ledger = new OperationOutcomeLedger();
    const snapshot = [{
      toolCallId: 'legacy-1',
      toolName: 'write_file',
      status: 'completed' as const,
      effect: 'local_change' as const,
      risk: 'low' as const,
      disposition: 'executed' as const,
      scope: 'target:notes.txt',
      receipt: { target: 'notes.txt', summary: 'written' },
      at: 1,
      reversibility: 'reversible' as const,
      legacySynthetic: true,
    }];

    ledger.restore(snapshot);
    ledger.restore(snapshot);
    snapshot[0].receipt.summary = 'mutated';

    const exported = ledger.snapshot();
    exported[0].receipt!.summary = 'also-mutated';
    expect(ledger.getByToolCallId('legacy-1')).toMatchObject({
      receipt: { summary: 'written' },
      reversibility: 'reversible',
      legacySynthetic: true,
    });

    ledger.replace([]);
    expect(ledger.list()).toEqual([]);
  });
});
