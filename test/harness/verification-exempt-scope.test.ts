/**
 * verification-exempt-config 作用域隔离测试（P1-10）。
 *
 * 验证 runWithVerificationExemptScope 使并发会话各自隔离，
 * 互不覆盖验收豁免配置；无作用域时回退到进程级全局。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  isProjectCustomExemptPath,
  resetVerificationExemptRuntime,
  runWithVerificationExemptScope,
  setVerificationExemptRuntime,
  getVerificationExemptDirPrefixes,
} from '../../src/harness/verification-exempt-config.js';

afterEach(() => {
  resetVerificationExemptRuntime();
});

describe('verification-exempt scope isolation', () => {
  it('isolates concurrent scopes (no cross-session overwrite)', async () => {
    // 模拟两个并发会话：各自在自己的作用域内设置不同的豁免目录与工作区。
    const results: Record<string, boolean> = {};

    const sessionA = runWithVerificationExemptScope(async () => {
      setVerificationExemptRuntime({ workspaceRoot: 'E:/proj/a', prefixes: ['.scratch-a'] });
      // 让出事件循环，模拟会话 B 在此期间运行并设置自己的配置
      await new Promise((r) => setTimeout(r, 5));
      // A 作用域内应仍看到 A 的配置，不被 B 覆盖
      results.aSeesA = isProjectCustomExemptPath('E:/proj/a/.scratch-a/x.md');
      results.aSeesB = isProjectCustomExemptPath('E:/proj/b/.scratch-b/y.md');
    });

    const sessionB = runWithVerificationExemptScope(async () => {
      setVerificationExemptRuntime({ workspaceRoot: 'E:/proj/b', prefixes: ['.scratch-b'] });
      await new Promise((r) => setTimeout(r, 5));
      results.bSeesB = isProjectCustomExemptPath('E:/proj/b/.scratch-b/y.md');
      results.bSeesA = isProjectCustomExemptPath('E:/proj/a/.scratch-a/x.md');
    });

    await Promise.all([sessionA, sessionB]);

    expect(results.aSeesA).toBe(true);
    expect(results.aSeesB).toBe(false);
    expect(results.bSeesB).toBe(true);
    expect(results.bSeesA).toBe(false);
  });

  it('scope does not leak to global runtime', async () => {
    await runWithVerificationExemptScope(async () => {
      setVerificationExemptRuntime({ workspaceRoot: 'E:/proj/a', prefixes: ['.scratch-a'] });
      expect(getVerificationExemptDirPrefixes()).toEqual(['.scratch-a']);
    });
    // 作用域结束后，全局运行时未被污染
    expect(getVerificationExemptDirPrefixes()).toEqual([]);
    expect(isProjectCustomExemptPath('E:/proj/a/.scratch-a/x.md')).toBe(false);
  });

  it('falls back to global runtime when no scope is active', () => {
    setVerificationExemptRuntime({ workspaceRoot: 'E:/proj/g', prefixes: ['.scratch-g'] });
    expect(isProjectCustomExemptPath('E:/proj/g/.scratch-g/x.md')).toBe(true);
  });
});
