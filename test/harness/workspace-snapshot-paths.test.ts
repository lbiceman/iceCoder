import { describe, expect, it } from 'vitest';

import {
  extractLikelyFilePathsFromText,
  resolveLikelyPathsInWorkspace,
} from '../../src/harness/workspace-snapshot.js';

describe('workspace-snapshot path hints', () => {
  it('extracts bare css filenames and nested paths from user text', () => {
    const paths = extractLikelyFilePathsFromText('修改 tokens.css 中夜间模式的主题色');
    expect(paths).toContain('tokens.css');

    const nested = extractLikelyFilePathsFromText('请改 src/public/css/tokens.css 里的 accent');
    expect(nested).toContain('src/public/css/tokens.css');
  });

  it('resolves bare filenames under workspace root', async () => {
    const resolved = await resolveLikelyPathsInWorkspace(process.cwd(), ['tokens.css']);
    expect(resolved.some((p) => p.endsWith('tokens.css'))).toBe(true);
  });
});
