import { describe, expect, it } from 'vitest';
import { checkWorkspacePathViolation } from '../../src/harness/workspace-path-guard.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('workspace-path-guard glob/grep', () => {
  it('blocks grep with relative path outside locked root', () => {
    const msg = checkWorkspacePathViolation(
      'grep',
      { pattern: 'foo', path: '..' },
      repoRoot,
      [],
    );
    expect(msg).toMatch(/Workspace Lock|outside locked workspace/i);
  });

  it('allows grep within locked root', () => {
    const msg = checkWorkspacePathViolation(
      'grep',
      { pattern: 'createSearchTools', path: 'src/tools' },
      repoRoot,
      [],
    );
    expect(msg).toBeUndefined();
  });

  it('blocks glob with directory escape', () => {
    const msg = checkWorkspacePathViolation(
      'glob',
      { pattern: '**/*', directory: '../' },
      repoRoot,
      [],
    );
    expect(msg).toMatch(/Workspace Lock|outside locked workspace/i);
  });
});
