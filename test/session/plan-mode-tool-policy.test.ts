import { describe, expect, it } from 'vitest';
import {
  evaluatePlanModeToolCall,
  filterPlanModeToolDefinitions,
  isPlanModeDocumentPath,
  PLAN_MODE_BLOCKED_GENERIC_MESSAGE,
} from '../../src/session/plan-mode-tool-policy.js';

describe('plan-mode-tool-policy', () => {
  it('allows read/search tools and document writes', () => {
    expect(evaluatePlanModeToolCall('read_file', { path: 'src/a.ts' })).toEqual({ allowed: true });
    expect(evaluatePlanModeToolCall('write_file', { path: 'docs/plan.md' })).toEqual({ allowed: true });
    expect(evaluatePlanModeToolCall('edit_file', { path: 'notes.txt' })).toEqual({ allowed: true });
    expect(evaluatePlanModeToolCall('request_analysis', { task: 'review gaps' }).allowed).toBe(false);
  });

  it('blocks code writes, commands, git, fs, and MCP', () => {
    expect(evaluatePlanModeToolCall('write_file', { path: 'src/app.ts' }).allowed).toBe(false);
    expect(evaluatePlanModeToolCall('run_command', { command: 'npm test' })).toEqual({
      allowed: false,
      message: PLAN_MODE_BLOCKED_GENERIC_MESSAGE,
    });
    expect(evaluatePlanModeToolCall('git', { action: 'status' }).allowed).toBe(false);
    expect(evaluatePlanModeToolCall('fs_operation', { action: 'delete', path: 'a.ts' }).allowed).toBe(false);
    expect(evaluatePlanModeToolCall('mcp_browser_navigate', {}).allowed).toBe(false);
  });

  it('filters offering to read + document write tools', () => {
    const filtered = filterPlanModeToolDefinitions([
      { name: 'read_file', description: '', parameters: {} },
      { name: 'write_file', description: '', parameters: {} },
      { name: 'run_command', description: '', parameters: {} },
      { name: 'mcp_foo', description: '', parameters: {} },
    ]);
    expect(filtered.map((t) => t.name)).toEqual(['read_file', 'write_file']);
  });

  it('recognizes document extensions only', () => {
    expect(isPlanModeDocumentPath('docs/a.md')).toBe(true);
    expect(isPlanModeDocumentPath('README.markdown')).toBe(true);
    expect(isPlanModeDocumentPath('src/main.ts')).toBe(false);
    expect(isPlanModeDocumentPath('package.json')).toBe(false);
  });
});
