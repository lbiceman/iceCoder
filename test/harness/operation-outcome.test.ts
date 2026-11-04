import { describe, expect, it } from 'vitest';

import { evaluateCompletionHardState } from '../../src/harness/completion-state.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import {
  normalizeOperationOutcome,
  OperationOutcomeLedger,
  recordToolOperationOutcomes,
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
      { id: 'a1', name: 'run_command', arguments: { command: 'npm test', background: true } },
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

  it('does not treat source text inside a read as approval, denial, or a pending job', () => {
    const output = [
      '📄 src/harness/harness-tool-executor.ts',
      'User denied tool read_file.',
      'Tool read_file requires confirmation but no confirmation handler is configured.',
      'denied by policy',
      'not available in this turn',
      "outcome.status !== 'awaiting_approval'",
      'status: pending',
      'running in the background',
    ].join('\n');
    const call = { id: 'r1', name: 'read_file', arguments: { path: 'src/harness/harness-tool-executor.ts' } };
    const direct = normalizeOperationOutcome(call, { success: true, output });
    expect(direct.status).toBe('completed');
    expect(direct.disposition).toBe('executed');

    const ledger = new OperationOutcomeLedger();
    const [recorded] = recordToolOperationOutcomes(ledger, {
      toolCalls: [call],
      messages: [{ role: 'tool', toolCallId: call.id, content: output }],
    });
    expect(recorded?.status).toBe('completed');
    expect(recorded?.disposition).toBe('executed');
    expect(evaluateCompletionHardState(ledger)).toBeNull();
  });

  it('still fails a read that the harness itself marked interrupted', () => {
    const call = { id: 'r2', name: 'open_file', arguments: { path: 'src/a.ts' } };
    const [outcome] = recordToolOperationOutcomes(new OperationOutcomeLedger(), {
      toolCalls: [call],
      messages: [{ role: 'tool', toolCallId: call.id, content: 'Tool execution was interrupted.' }],
    });
    expect(outcome?.status).toBe('failed');
    expect(outcome?.disposition).toBe('execution_fail');
  });

  it('still pauses when the executor blocks a read', () => {
    const call = { id: 'r3', name: 'grep', arguments: { pattern: 'x', path: 'src' } };
    const ledger = new OperationOutcomeLedger();
    const [outcome] = recordToolOperationOutcomes(ledger, {
      toolCalls: [call],
      messages: [{
        role: 'tool',
        toolCallId: call.id,
        content: 'Tool grep denied by policy: readonly disabled.',
      }],
      policyBlockedSignatures: [toolCallSignature(call)],
    });
    expect(outcome?.status).toBe('failed');
    expect(outcome?.disposition).toBe('policy_block');
    expect(evaluateCompletionHardState(ledger)).toMatchObject({
      status: 'paused',
      reason: 'operation_policy_blocked',
    });
  });

  it('still pauses when a command result is waiting for confirmation', () => {
    const call = { id: 'c1', name: 'run_command', arguments: { command: 'npm test' } };
    const ledger = new OperationOutcomeLedger();
    const [outcome] = recordToolOperationOutcomes(ledger, {
      toolCalls: [call],
      messages: [{
        role: 'tool',
        toolCallId: call.id,
        content: 'Tool run_command requires confirmation but no confirmation handler is configured. Please use a different approach or ask the user.',
      }],
    });
    expect(outcome?.status).toBe('awaiting_approval');
    expect(evaluateCompletionHardState(ledger)).toMatchObject({
      status: 'paused',
      reason: 'operation_pending',
    });
  });
});
