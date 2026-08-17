import { describe, expect, it } from 'vitest';
import { RELEASE_TGZ_REL, resolvePackedTgzPath, resolveReleaseTgzPath } from '../../scripts/copy-release-tgz.mjs';

describe('copy-release-tgz', () => {
  it('发布用 tgz 使用固定路径，便于 README 下载', () => {
    expect(RELEASE_TGZ_REL.replaceAll('\\', '/')).toBe('releases/npm/ice-coder.tgz');
    expect(resolveReleaseTgzPath('/repo').replaceAll('\\', '/')).toMatch(/releases\/npm\/ice-coder\.tgz$/);
    expect(resolvePackedTgzPath('/repo', { name: 'ice-coder', version: '1.0.1' }).replaceAll('\\', '/'))
      .toMatch(/ice-coder-1\.0\.1\.tgz$/);
  });
});
