import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  checkReadBeforeEdit,
  clearReadBeforeEditScope,
  markFileRead,
} from '../../src/tools/read-before-edit.js';
import path from 'node:path';

const workDir = path.resolve('/proj');

describe('read-before-edit', () => {
  beforeEach(() => {
    process.env.ICE_READ_BEFORE_EDIT = '1';
    clearReadBeforeEditScope(workDir, 's1');
    clearReadBeforeEditScope(workDir, 's2');
  });

  afterEach(() => {
    delete process.env.ICE_READ_BEFORE_EDIT;
    clearReadBeforeEditScope(workDir, 's1');
    clearReadBeforeEditScope(workDir, 's2');
  });

  it('blocks edit until read_file', () => {
    expect(checkReadBeforeEdit(workDir, 'src/a.ts', 's1')).toMatch(/read-before-edit/);
    markFileRead(workDir, 'src/a.ts', 's1');
    expect(checkReadBeforeEdit(workDir, 'src/a.ts', 's1')).toBeNull();
  });

  it('isolates reads by sessionId', () => {
    markFileRead(workDir, 'src/a.ts', 's1');
    expect(checkReadBeforeEdit(workDir, 'src/a.ts', 's2')).toMatch(/read-before-edit/);
  });

  it('can be disabled via env', () => {
    process.env.ICE_READ_BEFORE_EDIT = '0';
    expect(checkReadBeforeEdit(workDir, 'src/a.ts', 's1')).toBeNull();
  });
});
