import { describe, expect, it } from 'vitest';

import { buildFileChangeDiff } from '../../src/tools/file-change-diff.js';
import { revertContentUsingUnifiedDiff } from '../../src/harness/session-workspace-restore.js';

describe('session-workspace-restore', () => {
  it('reverts file content using unified diff from tool output', () => {
    const oldContent = '--accent: #39D1E0;\n--accent-hover: #5edae7;';
    const newContent = '--accent: #3BEA7C;\n--accent-hover: #6cf0a0;';
    const diff = buildFileChangeDiff(oldContent, newContent, 'src/public/css/tokens.css');
    expect(diff).toBeTruthy();

    const reverted = revertContentUsingUnifiedDiff(newContent, diff!);
    expect(reverted).toBe(oldContent);
  });
});
