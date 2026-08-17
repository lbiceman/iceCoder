import { describe, expect, it } from 'vitest';
import {
  bumpPatch,
  listPackTarballs,
  patchJsonVersionField,
  shouldBumpVersion,
} from '../../scripts/bump-pack-version.mjs';

describe('bumpPatch', () => {
  it('patch +1', () => {
    expect(bumpPatch('1.0.0')).toBe('1.0.1');
    expect(bumpPatch('1.2.9')).toBe('1.2.10');
  });
});

describe('shouldBumpVersion', () => {
  it('本地默认自增', () => {
    expect(shouldBumpVersion({})).toBe(true);
  });

  it('CI 默认不自增，ICE_BUMP_VERSION 可覆盖', () => {
    expect(shouldBumpVersion({ CI: 'true' })).toBe(false);
    expect(shouldBumpVersion({ CI: 'true', ICE_BUMP_VERSION: '1' })).toBe(true);
    expect(shouldBumpVersion({ ICE_BUMP_VERSION: '0' })).toBe(false);
  });
});

describe('patchJsonVersionField', () => {
  it('只改指定次数的 version 字段', () => {
    const src = `{
  "version": "1.0.0",
  "packages": {
    "": { "version": "1.0.0" }
  },
  "other": { "version": "1.0.0" }
}`;
    const out = patchJsonVersionField(src, '1.0.0', '1.0.1', 2);
    expect(out).toContain('"version": "1.0.1"');
    expect(out.match(/"version": "1.0.1"/g)?.length).toBe(2);
    expect(out).toContain('"other": { "version": "1.0.0" }');
  });
});

describe('listPackTarballs', () => {
  it('只匹配本包 tgz', () => {
    expect(listPackTarballs([
      'ice-coder-1.0.0.tgz',
      'ice-coder-1.0.1.tgz',
      'other-1.0.0.tgz',
      'package.json',
    ])).toEqual(['ice-coder-1.0.0.tgz', 'ice-coder-1.0.1.tgz']);
  });
});
