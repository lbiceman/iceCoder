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
  clearResolvedVerificationFailures,
} from '../../src/harness/failure-evidence-recovery.js';

describe('failure-evidence-recovery', () => {
  it('detects failed tool result content variants', () => {
    expect(isFailedToolResultContent('Tool execution error: boom')).toBe(true);
    expect(isFailedToolResultContent('[Tool skipped] x')).toBe(true);
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

  it('appends buffered verification output when compaction dropped the failing command', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed('npm test', 'FAIL src/a.test.ts\nexpected true');
    const messages: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'src/a.ts' } }] },
      { role: 'tool', toolCallId: '1', content: 'Tool execution error: ENOENT' },
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
    expect(buildLightFailureHintMessage(2)).toMatch(/retry the same listed mcp_/);
    expect(buildStrongFailureWarningMessage(7)).toMatch(/Warning: 7 consecutive/);
    expect(buildStrongFailureWarningMessage(7)).toMatch(/still-listed ready mcp_/);
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

  it('an unrelated successful command keeps the acceptance failure evidence', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed('npm test', 'FAIL src/a.test.ts');
    clearResolvedVerificationFailures(buffer, new Map([
      ['t1', { kind: 'foreground', command: 'git status', foregroundSuccess: true }],
      ['t2', { kind: 'background_start', command: 'npm test' }],
      ['t3', { kind: 'foreground', command: 'npm test', foregroundSuccess: false, exitCode: 1 }],
    ]));
    expect(buffer.snapshot().map(entry => entry.command)).toEqual(['npm test']);
  });

  it('a passing rerun of the same command clears only that command', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed('npm test', 'FAIL src/a.test.ts');
    buffer.recordFailed('npm run lint', 'lint error');
    clearResolvedVerificationFailures(buffer, new Map([
      ['t1', { kind: 'foreground', command: 'cd app && npm  test 2>&1', foregroundSuccess: true }],
    ]));
    expect(buffer.snapshot().map(entry => entry.command)).toEqual(['npm run lint']);

    clearResolvedVerificationFailures(buffer, new Map([
      ['t2', { kind: 'background_completed', command: 'npm test && npm run lint', exitCode: 0 }],
    ]));
    expect(buffer.snapshot()).toEqual([]);
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
