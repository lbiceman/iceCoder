import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalWorkspacePath,
  extractRunCommand,
  extractToolTargetPath,
} from '../../src/harness/tool-target-path.js';

describe('tool-target-path', () => {
  it('canonicalWorkspacePath normalizes absolute paths under workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-target-path-'));
    const abs = join(root, 'src', 'scenes', 'ShopScene.ts');
    mkdirSync(join(root, 'src', 'scenes'), { recursive: true });
    writeFileSync(abs, 'export {};\n');

    const expected = process.platform === 'win32'
      ? 'src/scenes/shopscene.ts'
      : 'src/scenes/ShopScene.ts';
    expect(canonicalWorkspacePath(root, abs)).toBe(expected);
    expect(canonicalWorkspacePath(root, 'src/scenes/ShopScene.ts')).toBe(expected);
  });

  it('extracts write targets and run_command text', () => {
    expect(extractToolTargetPath('edit_file', { path: ' src/a.ts ' })).toBe('src/a.ts');
    expect(extractToolTargetPath('read_file', { path: 'src/a.ts' })).toBeUndefined();
    expect(extractRunCommand({ command: ' npm test ' })).toBe('npm test');
    expect(extractRunCommand({})).toBeUndefined();
  });
});
