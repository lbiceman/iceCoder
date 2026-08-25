import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TGZ_REL, resolvePackedTgzPath, resolveReleaseTgzPath } from '../../scripts/copy-release-tgz.mjs';
import { findSelfDependency } from '../../scripts/assert-no-self-dep.mjs';

describe('copy-release-tgz', () => {
  it('发布用 tgz 使用固定路径，便于 README 下载', () => {
    expect(RELEASE_TGZ_REL.replaceAll('\\', '/')).toBe('releases/npm/ice-coder.tgz');
    expect(resolveReleaseTgzPath('/repo').replaceAll('\\', '/')).toMatch(/releases\/npm\/ice-coder\.tgz$/);
    expect(resolvePackedTgzPath('/repo', { name: 'ice-coder', version: '1.0.1' }).replaceAll('\\', '/'))
      .toMatch(/ice-coder-1\.0\.1\.tgz$/);
  });

  it('package.json 不得把 ice-coder 自己写成 file: tgz 依赖', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(findSelfDependency(pkg)).toBeNull();
    expect(findSelfDependency({
      name: 'ice-coder',
      dependencies: { 'ice-coder': 'file:releases/npm/ice-coder.tgz' },
    })).toEqual({ field: 'dependencies', spec: 'file:releases/npm/ice-coder.tgz' });
  });
});
