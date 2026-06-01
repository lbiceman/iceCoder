import { describe, expect, it } from 'vitest';
import {
  STEP_OUTPUT_PREVIEW_DEFAULT,
  STEP_OUTPUT_PREVIEW_DIFF,
  stepToolOutputPreview,
} from '../../src/harness/tool-step-preview.js';

describe('tool-step-preview', () => {
  it('uses default limit for non-diff tools', () => {
    const long = 'x'.repeat(STEP_OUTPUT_PREVIEW_DEFAULT + 100);
    const preview = stepToolOutputPreview('read_file', long);
    expect(preview.length).toBeLessThan(long.length);
    expect(preview).toContain('UI preview truncated');
  });

  it('uses extended limit for diff-capable tools', () => {
    const diffBody = '@@ -1 +1 @@\n' + '+line\n'.repeat(2000);
    const long = diffBody + 'y'.repeat(STEP_OUTPUT_PREVIEW_DIFF);
    const preview = stepToolOutputPreview('git', long);
    expect(preview.length).toBeGreaterThan(STEP_OUTPUT_PREVIEW_DEFAULT);
    expect(preview.length).toBeLessThanOrEqual(STEP_OUTPUT_PREVIEW_DIFF + 80);
  });

  it('detects diff output by content for run_command', () => {
    const header = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n';
    const long = header + '+\n'.repeat(STEP_OUTPUT_PREVIEW_DEFAULT + 50);
    const preview = stepToolOutputPreview('run_command', long);
    expect(preview.length).toBeGreaterThan(STEP_OUTPUT_PREVIEW_DEFAULT);
  });

  it('returns short output unchanged', () => {
    expect(stepToolOutputPreview('patch_file', '@@ -1 +1 @@\n+ok')).toBe('@@ -1 +1 @@\n+ok');
  });
});
