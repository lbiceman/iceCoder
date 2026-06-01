import { describe, expect, it } from 'vitest';

import {
  formatRunCommandToolDetail,
  formatToolArgsDetailPreview,
  isTerminalBackgroundStatus,
  parseCheckTaskResult,
  resolveToolCallInitialStatus,
  resolveToolTraceResultStatus,
} from '../../src/web/tool-trace-format.js';

describe('tool-trace-format', () => {
  it('formats check action as readable detail', () => {
    expect(formatRunCommandToolDetail({ action: 'check', task_id: 'bg_xdgtov' }))
      .toBe('check bg_xdgtov');
  });

  it('formats list/stop background management actions', () => {
    expect(formatRunCommandToolDetail({ action: 'list' })).toBe('list background tasks');
    expect(formatRunCommandToolDetail({ action: 'stop', task_id: 'bg_abc' })).toBe('stop bg_abc');
  });

  it('prefers shell command for normal run_command', () => {
    expect(formatToolArgsDetailPreview('run_command', {
      command: 'node scripts/fix9-tasks.cjs && npm test 2>&1',
    })).toBe('node scripts/fix9-tasks.cjs && npm test 2>&1');
  });

  it('marks background and escalated results with background status', () => {
    const bgOutput = JSON.stringify({ mode: 'background', taskId: 'bg_1' });
    const escOutput = JSON.stringify({ mode: 'escalated', taskId: 'bg_2' });
    expect(resolveToolTraceResultStatus('run_command', true, 'executed', bgOutput)).toBe('background');
    expect(resolveToolTraceResultStatus('run_command', true, 'executed', escOutput)).toBe('background');
    expect(resolveToolTraceResultStatus('run_command', true, 'executed', '{"mode":"foreground"}')).toBe('success');
  });

  it('uses background icon at tool_call for long commands and explicit background', () => {
    expect(resolveToolCallInitialStatus('run_command', { command: 'npm test 2>&1' })).toBe('background');
    expect(resolveToolCallInitialStatus('run_command', { command: 'git status' })).toBe('pending');
    expect(resolveToolCallInitialStatus('run_command', { command: 'echo hi', background: true })).toBe('background');
    expect(resolveToolCallInitialStatus('run_command', { action: 'check', task_id: 'bg_1' })).toBe('pending');
    expect(resolveToolCallInitialStatus('write_file', { path: 'a.txt' })).toBe('pending');
  });

  it('parses terminal check results', () => {
    const info = parseCheckTaskResult(JSON.stringify({
      mode: 'check',
      taskId: 'bg_xdgtov',
      status: 'failed',
      exitCode: 1,
    }));
    expect(info).toEqual({ taskId: 'bg_xdgtov', status: 'failed', exitCode: 1 });
    expect(isTerminalBackgroundStatus('failed')).toBe(true);
    expect(isTerminalBackgroundStatus('running')).toBe(false);
  });
});
