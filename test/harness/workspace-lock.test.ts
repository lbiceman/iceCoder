import { describe, expect, it } from 'vitest';

import {
  detectWorkspaceFromUserMessage,
  mergeWorkspaceDetection,
  normalizeDetectedPath,
  preprocessWorkspaceMessage,
  emptySessionWorkspaceState,
} from '../../src/harness/workspace-lock.js';
import { buildWorkspaceAnchorContent } from '../../src/harness/workspace-anchor.js';
import { checkWorkspacePathViolation } from '../../src/harness/workspace-path-guard.js';

describe('workspace-lock', () => {
  it('normalizeDetectedPath converts D:// style paths', () => {
    expect(normalizeDetectedPath('D://foo/bar')).toBe('D:\\foo\\bar');
  });

  it('locks on standalone path line (delayed lock, round N)', () => {
    const msg = [
      '先讨论一下需求，不写代码。',
      '',
      'E:\\test\\agentToolTest\\implement-spellbrigade-survivor-second',
      '',
      '请实现幸存者游戏核心循环。',
    ].join('\n');
    const result = detectWorkspaceFromUserMessage(msg);
    expect(result.lockedRoot?.toLowerCase()).toBe(
      'e:\\test\\agentToolTest\\implement-spellbrigade-survivor-second'.toLowerCase(),
    );
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('initial_lock');
  });

  it('D read + E write: locks E, references D md', () => {
    const msg =
      '在 D://XXX/read/webpack 中获取 xvqiu.md，去 E://324huih/dsgdhuih324/fdgi 项目中实现';
    const result = detectWorkspaceFromUserMessage(msg);
    expect(result.lockedRoot?.toLowerCase()).toContain('fdgi');
    expect(result.referenceReads.some((r) => r.toLowerCase().includes('xvqiu.md'))).toBe(true);
    expect(result.lockedRoot?.toLowerCase()).not.toContain('webpack');
  });

  it('fdgi implement + xvqiu.md feature reference', () => {
    const msg = [
      '在 E://324huih/dsgdhuih324/fdgi 中实现',
      'E://324ij/324ji3o/xvqiu.md 中的功能',
    ].join('\n');
    const result = detectWorkspaceFromUserMessage(msg);
    expect(result.lockedRoot?.toLowerCase()).toContain('fdgi');
    expect(result.referenceReads.some((r) => r.toLowerCase().endsWith('xvqiu.md'))).toBe(true);
    expect(result.lockedRoot?.toLowerCase()).not.toContain('324ji3o');
  });

  it('changes workspace on explicit switch phrase', () => {
    const prev = {
      lockedRoot: 'E:\\old\\repo',
      referenceReads: [] as string[],
    };
    const msg = '工作目录改为 E:\\new\\repo，继续刚才的任务';
    const result = detectWorkspaceFromUserMessage(msg, prev);
    expect(result.lockedRoot?.toLowerCase()).toBe('e:\\new\\repo');
    expect(result.reason).toBe('workspace_change');
    expect(result.changeNotice).toContain('Workspace Change');
  });

  it('does not lock on casual path mention', () => {
    const msg = '可以参考 E:\\other\\demo 的写法，但我们还没定目录';
    const result = detectWorkspaceFromUserMessage(msg);
    expect(result.lockedRoot).toBeUndefined();
    expect(result.changed).toBe(false);
  });

  it('does not lock on 开始吧 without path', () => {
    const result = detectWorkspaceFromUserMessage('好的，开始吧');
    expect(result.lockedRoot).toBeUndefined();
  });

  it('mergeWorkspaceDetection sets lockedAt on initial lock', () => {
    const merged = mergeWorkspaceDetection(emptySessionWorkspaceState(), {
      lockedRoot: 'E:\\proj',
      referenceReads: [],
      changed: true,
      reason: 'initial_lock',
    });
    expect(merged.lockedRoot).toBe('E:\\proj');
    expect(merged.lockedAt).toBeTruthy();
    expect(merged.changeCount).toBe(0);
  });

  it('buildWorkspaceAnchorContent lists root and references', () => {
    const content = buildWorkspaceAnchorContent('E:\\proj', ['D:\\ref\\req.md']);
    expect(content).toContain('[Workspace Anchor]');
    expect(content).toContain('E:\\proj');
    expect(content).toContain('D:\\ref\\req.md');
  });

  it('path guard blocks write outside locked root', () => {
    const violation = checkWorkspacePathViolation(
      'write_file',
      { path: 'D:\\outside\\a.ts', content: 'x' },
      'E:\\proj',
      [],
    );
    expect(violation).toMatch(/Workspace Lock/);
  });

  it('path guard allows read outside locked root without referenceReads', () => {
    const violation = checkWorkspacePathViolation(
      'read_file',
      { path: 'D:\\ref\\xvqiu.md' },
      'E:\\proj',
      [],
    );
    expect(violation).toBeUndefined();
  });

  it('path guard allows parse_document outside locked root', () => {
    const violation = checkWorkspacePathViolation(
      'parse_document',
      { path: 'D:\\docs\\spec.pdf' },
      'E:\\proj',
      [],
    );
    expect(violation).toBeUndefined();
  });

  it('switches from D to E when second message uses 增加 on same line', () => {
    let state = emptySessionWorkspaceState();
    const d1 = detectWorkspaceFromUserMessage(
      'D://djsiogfdsj/213/42/43/4    实现XXX功能',
      state,
    );
    state = mergeWorkspaceDetection(state, d1);
    expect(d1.lockedRoot?.toLowerCase()).toBe('d:\\djsiogfdsj\\213\\42\\43\\4');

    const d2 = detectWorkspaceFromUserMessage(
      'E://2134j23j4ijo23j4io  增加XXX模块',
      state,
    );
    expect(d2.lockedRoot?.toLowerCase()).toBe('e:\\2134j23j4ijo23j4io');
    expect(d2.reason).toBe('workspace_change');
    expect(d2.changeNotice).toContain('Workspace Change');
  });

  it('preprocessWorkspaceMessage fixes D;// typo to lock with drive letter', () => {
    const msg = 'D;//djsiogfdsj/213/42/43/4    实现XXX功能';
    const result = detectWorkspaceFromUserMessage(msg);
    expect(result.lockedRoot?.toLowerCase()).toBe('d:\\djsiogfdsj\\213\\42\\43\\4');
  });

  it('path guard blocks fs_operation delete outside workspace', () => {
    const violation = checkWorkspacePathViolation(
      'fs_operation',
      { operation: 'delete', path: 'D:\\outside\\a.ts' },
      'E:\\proj',
      [],
    );
    expect(violation).toMatch(/Workspace Lock/);
  });

  it('path guard allows browse_directory outside workspace', () => {
    const violation = checkWorkspacePathViolation(
      'browse_directory',
      { path: 'D:\\outside' },
      'E:\\proj',
      [],
    );
    expect(violation).toBeUndefined();
  });

  it('path guard allows list_drives when workspace locked', () => {
    const violation = checkWorkspacePathViolation(
      'list_drives',
      {},
      'E:\\proj',
      [],
    );
    expect(violation).toBeUndefined();
  });

  it('normalizeDetectedPath fixes semicolon after drive letter', () => {
    expect(preprocessWorkspaceMessage('D;//foo')).toBe('D://foo');
    expect(normalizeDetectedPath('D;//foo/bar')).toBe('D:\\foo\\bar');
  });

  it('path guard allows cd /d into locked workspace then npm test', () => {
    const locked = 'E:\\test\\agentToolTest\\implement-spellbrigade-survivor-second';
    const violation = checkWorkspacePathViolation(
      'run_command',
      { command: `cd /d "${locked}" && npm test` },
      locked,
      [],
    );
    expect(violation).toBeUndefined();
  });

  it('path guard blocks cd /d outside locked workspace', () => {
    const violation = checkWorkspacePathViolation(
      'run_command',
      { command: 'cd /d D:\\other && npm test' },
      'E:\\proj',
      [],
    );
    expect(violation).toMatch(/Workspace Lock/);
    expect(violation).toMatch(/D:\\other/i);
  });

  it('path guard still blocks outside path in command remainder after in-root cd', () => {
    const locked = 'E:\\proj';
    const violation = checkWorkspacePathViolation(
      'run_command',
      { command: `cd /d ${locked} && copy D:\\outside\\a.txt .` },
      locked,
      [],
    );
    expect(violation).toMatch(/D:\\outside/i);
  });

  it('path guard still blocks unix absolute paths like /data/foo', () => {
    const violation = checkWorkspacePathViolation(
      'run_command',
      { command: 'npm run build --output /data/out' },
      'E:\\proj',
      [],
    );
    expect(violation).toMatch(/\/data\/out/);
  });
});
