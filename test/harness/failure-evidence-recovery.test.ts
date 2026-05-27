import { describe, expect, it } from 'vitest';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { VerificationOutputBuffer } from '../../src/harness/verification-output-buffer.js';
import {
  buildFailureEvidencePackMessage,
  buildLightFailureHintMessage,
  buildStrongFailureWarningMessage,
  collectFailureEvidenceEntries,
  isFailedToolResultContent,
  purgeEphemeralFailureRecoveryMessages,
  purgeEphemeralFailureRecoveryMessagesInPlace,
  roundHadSuccessfulVerification,
} from '../../src/harness/failure-evidence-recovery.js';

describe('failure-evidence-recovery', () => {
  it('detects failed tool result content variants', () => {
    expect(isFailedToolResultContent('Tool execution error: boom')).toBe(true);
    expect(isFailedToolResultContent('[BranchBudget / Blocked] x')).toBe(true);
    expect(isFailedToolResultContent('ok')).toBe(false);
  });

  it('collects recent failure bodies with labels', () => {
    const messages: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'run_command', arguments: { command: 'npm test' } }] },
      { role: 'tool', toolCallId: '1', content: 'Tool execution error: failed\nAssertionError: expected 1' },
    ];
    const entries = collectFailureEvidenceEntries(messages);
    expect(entries.length).toBe(1);
    expect(entries[0]!.label).toContain('npm test');
    expect(entries[0]!.body).toContain('AssertionError');
  });

  it('appends buffered verification output when branch block hid stderr', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed('npm test', 'FAIL src/a.test.ts\nexpected true');
    const messages: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'run_command', arguments: { command: 'npm test' } }] },
      { role: 'tool', toolCallId: '1', content: '[BranchBudget / Blocked] retry cap' },
    ];
    const entries = collectFailureEvidenceEntries(messages, buffer);
    expect(entries.some(e => e.label.includes('buffered'))).toBe(true);
    expect(entries.some(e => e.body.includes('FAIL src/a.test.ts'))).toBe(true);
  });

  it('builds evidence pack message with failure count', () => {
    const msg = buildFailureEvidencePackMessage(4, [
      { toolName: 'run_command', label: 'run_command: npm test', body: 'error output' },
    ]);
    expect(msg).toContain('[Failure Evidence — 4 consecutive');
    expect(msg).toContain('error output');
    expect(msg).toContain('Do NOT repeat');
  });

  it('builds light and strong hint messages', () => {
    expect(buildLightFailureHintMessage(2)).toMatch(/2 consecutive/);
    expect(buildStrongFailureWarningMessage(7)).toMatch(/Warning: 7 consecutive/);
  });

  it('purges ephemeral messages in place', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'keep', ephemeralFailureRecovery: 'light' },
      { role: 'user', content: 'stay' },
    ];
    purgeEphemeralFailureRecoveryMessagesInPlace(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('stay');
  });

  it('purges only selected ephemeral kind', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'light', ephemeralFailureRecovery: 'light' },
      { role: 'user', content: 'evidence', ephemeralFailureRecovery: 'evidence' },
    ];
    const next = purgeEphemeralFailureRecoveryMessages(messages, 'evidence');
    expect(next).toHaveLength(1);
    expect(next[0]!.content).toBe('light');
  });

  it('detects successful verification in round', () => {
    expect(roundHadSuccessfulVerification(
      [{ id: 't1', name: 'run_command', arguments: { command: 'npm test' } }],
      [],
    )).toBe(true);
    expect(roundHadSuccessfulVerification(
      [{ id: 't1', name: 'run_command', arguments: { command: 'npm test' } }],
      ['run_command:{"command":"npm test"}'],
    )).toBe(false);
  });
});

describe('VerificationOutputBuffer.clear', () => {
  it('clears recorded failures', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed('npm test', 'fail body');
    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
  });
});
