import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShellTool } from '../../src/tools/builtin/shell-tool.js';

/**
 * Phase 1 集成测试：验证 classifier 决策正确接通 shell-tool。
 *
 * 这些测试不真正派生长进程，只验证：
 * - long 命令被识别为后台（返回 mode:'background'）
 * - short 命令前台执行
 * - rm -rf blocked by shell blacklist
 * - background:false 强制前台
 */
describe('shell-tool — classifier integration', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-shell-classifier-'));
  });

  it('routes "npm test" to background automatically (no background flag)', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ command: 'npm test' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.mode).toBe('background');
    expect(parsed.taskId).toMatch(/^bg_/);
    expect(parsed.classifiedAs).toBe('long');
  });

  it('routes "docker build ." to background', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ command: 'docker build .' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.mode).toBe('background');
    expect(parsed.classifiedAs).toBe('long');
  });

  it('runs "echo hello" foreground synchronously', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ command: 'echo hello' });
    expect(result.success).toBe(true);
    // foreground returns output directly, not JSON wrapper
    expect(result.output).toMatch(/hello/i);
  });

  it('runs "git --version" foreground (short)', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ command: 'git --version' });
    // git may or may not be present; just verify it's NOT routed to background
    expect(result.output).not.toMatch(/"mode":\s*"background"/);
  });

  it('explicit background:false forces foreground even for long commands', async () => {
    const tool = createShellTool(workDir);
    // We use a fake long command that classifier marks 'long', but background:false overrides.
    // Use a command that will fail quickly (so we don't wait full 30s).
    const result = await tool.handler({
      command: 'npm run --no-such-command',
      background: false,
      timeout: 5_000,
    });
    // Should NOT have mode:'background' — runs foreground (and likely fails)
    expect(result.output).not.toMatch(/"mode":\s*"background"/);
  });

  it('explicit background:true keeps backward-compatible 5min timeout', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({
      command: 'echo hello',  // short command, but explicit background:true forces bg
      background: true,
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.mode).toBe('background');
    expect(parsed.timeout).toBe('300s');
  });

  it('long classifier with background:true picks 24h timeout', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({
      command: 'npm test',
      background: true,
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.mode).toBe('background');
    // 24h = 86400s
    expect(parsed.timeout).toBe('86400s');
  });

  it('user-supplied timeout overrides classifier hard timeout', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({
      command: 'npm test',
      timeout: 60_000,  // 1 min
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.timeout).toBe('60s');
  });

  it('rm -rf is blocked by shell blacklist', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({
      command: 'rm -rf /tmp/some-nonexistent-path-icecoder-test',
      background: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Sandbox|blacklist/i);
  });

  it('empty command returns error', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ command: '   ' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/command/i);
  });

  it('cmd alias still works (long command via cmd field)', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ cmd: 'vitest' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.mode).toBe('background');
    expect(parsed.classifiedAs).toBe('long');
  });

  it('action:"list" still works (no classifier interference)', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ action: 'list' });
    expect(result.success).toBe(true);
    // either "No background tasks." or a JSON array
    expect(result.output).toBeDefined();
  });

  it('action:"check" with missing task_id returns error (no classifier interference)', async () => {
    const tool = createShellTool(workDir);
    const result = await tool.handler({ action: 'check' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/task_id/);
  });
});
