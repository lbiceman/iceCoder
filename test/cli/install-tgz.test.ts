import { describe, expect, it } from 'vitest';
import { resolveInstallArgs } from '../../scripts/install-tgz.mjs';

describe('install-tgz', () => {
  it('用 npm install -g --force 覆盖同版本旧包，不先 uninstall', () => {
    const args = resolveInstallArgs('/tmp/ice-coder-1.0.0.tgz');
    expect(args).toEqual(['install', '-g', '/tmp/ice-coder-1.0.0.tgz', '--force']);
    expect(args).not.toContain('uninstall');
  });
});
