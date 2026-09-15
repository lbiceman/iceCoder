import { describe, expect, it } from 'vitest';

import {
  classifyRunCommandResult,
  normalizeAcceptanceCommandKey,
  stripLeadingCdPrefix,
} from '../../src/harness/run-command-result.js';

describe('run-command-result', () => {
  it('classifies foreground success and failure', () => {
    expect(classifyRunCommandResult(
      { command: 'npm ci' },
      'install ok\n',
      true,
    )).toEqual({ kind: 'foreground', command: 'npm ci', foregroundSuccess: true });
    expect(classifyRunCommandResult(
      { command: 'npm test' },
      'Command failed (exit code: 1)',
      false,
    )).toEqual({ kind: 'foreground', command: 'npm test', foregroundSuccess: false });
  });

  it.each(['background', 'escalated'])(
    'classifies %s mode as a background start',
    (mode) => {
      const output = JSON.stringify({ mode, taskId: 'bg_abc', status: 'started' });
      expect(classifyRunCommandResult(
        { command: 'npm test 2>&1' },
        output,
        true,
      )).toEqual({ kind: 'background_start', command: 'npm test 2>&1' });
    },
  );

  it('classifies a running background check', () => {
    const output = JSON.stringify({
      mode: 'check',
      taskId: 'bg_abc',
      label: 'npm test',
      status: 'running',
    });
    expect(classifyRunCommandResult(
      { action: 'check', task_id: 'bg_abc' },
      output,
      true,
    )).toEqual({ kind: 'background_running', command: 'npm test' });
  });

  it('classifies completed background checks by exit code', () => {
    const success = JSON.stringify({
      label: 'npm run build',
      status: 'completed',
      exitCode: 0,
    });
    const failure = JSON.stringify({
      label: 'npm test',
      status: 'completed',
      exitCode: 1,
    });
    expect(classifyRunCommandResult(
      { action: 'check', task_id: 'bg_a' },
      success,
      true,
    )).toEqual({
      kind: 'background_completed',
      command: 'npm run build',
      exitCode: 0,
    });
    expect(classifyRunCommandResult(
      { action: 'check', task_id: 'bg_b' },
      failure,
      true,
    )).toEqual({
      kind: 'background_failed',
      command: 'npm test',
      exitCode: 1,
      statusLabel: 'completed_nonzero',
    });
  });

  it.each(['failed', 'timeout', 'killed'])(
    'classifies %s as a background failure',
    (status) => {
      const output = JSON.stringify({
        label: 'npm run test:e2e',
        status,
        exitCode: 2,
      });
      expect(classifyRunCommandResult(
        { action: 'check', task_id: 'bg_a' },
        output,
        false,
      )).toEqual({
        kind: 'background_failed',
        command: 'npm run test:e2e',
        exitCode: 2,
        statusLabel: status,
      });
    },
  );

  it('prefers the response command and falls back to the legacy label', () => {
    const withCommand = JSON.stringify({
      label: 'build-verify',
      command: 'npm run build 2>&1',
      status: 'completed',
      exitCode: 0,
    });
    const legacy = JSON.stringify({
      label: 'npm test',
      status: 'completed',
      exitCode: 0,
    });
    expect(classifyRunCommandResult(
      { action: 'check', task_id: 'bg_a' },
      withCommand,
      true,
    )).toEqual({
      kind: 'background_completed',
      command: 'npm run build 2>&1',
      exitCode: 0,
    });
    expect(classifyRunCommandResult(
      { action: 'check', task_id: 'bg_b' },
      legacy,
      true,
    )).toEqual({
      kind: 'background_completed',
      command: 'npm test',
      exitCode: 0,
    });
  });

  it('returns null for unusable background check output', () => {
    expect(classifyRunCommandResult(
      { action: 'check', task_id: 'bg_a' },
      'plain text',
      true,
    )).toBeNull();
    expect(classifyRunCommandResult(
      { action: 'list' },
      JSON.stringify({ status: 'running' }),
      true,
    )).toBeNull();
  });

  it('strips a leading cd prefix without changing a plain cd', () => {
    expect(stripLeadingCdPrefix('cd /d E:\\x && npm test')).toBe('npm test');
    expect(stripLeadingCdPrefix('cd ./x && ls')).toBe('ls');
    expect(stripLeadingCdPrefix('cd /tmp')).toBe('cd /tmp');
    expect(stripLeadingCdPrefix('npm test')).toBe('npm test');
  });

  it('normalizes command noise and executable identity', () => {
    expect(normalizeAcceptanceCommandKey('npm test 2>&1')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('npm test | tail -20')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('npm run build > out.log 2>&1')).toBe('npm run build');
    expect(normalizeAcceptanceCommandKey('cd /d E:\\foo && npm run build')).toBe('npm run build');
    expect(normalizeAcceptanceCommandKey('C:\\tools\\make.exe verify')).toBe('make verify');
    expect(normalizeAcceptanceCommandKey('"/opt/tools/make" verify')).toBe('make verify');
  });

  it('keeps opaque user command identities distinct', () => {
    expect(normalizeAcceptanceCommandKey('npx playwright test --reporter=list'))
      .toBe('npx playwright test --reporter=list');
    expect(normalizeAcceptanceCommandKey('npx vitest run --reporter=verbose'))
      .toBe('npx vitest run --reporter=verbose');
    expect(normalizeAcceptanceCommandKey('npm run test')).toBe('npm run test');
    expect(normalizeAcceptanceCommandKey('npm run test:e2e')).toBe('npm run test:e2e');
    expect(normalizeAcceptanceCommandKey('./scripts/ci.sh')).toBe('ci.sh');
    expect(normalizeAcceptanceCommandKey('cargo test')).toBe('cargo test');
  });
});
