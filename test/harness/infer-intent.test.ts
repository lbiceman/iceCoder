/**
 * inferIntent：路径中的 test 段（如 D:\\work\\test）不得单独判为 test 意图。
 */
import { describe, it, expect } from 'vitest';
import { inferIntent } from '../../src/harness/task-state.js';

describe('inferIntent', () => {
  it('路径含 \\\\test 但用户要生成代码 → edit', () => {
    expect(
      inferIntent('D:\\work\\test 在这个文件夹生成一个打砖块的游戏，好看点'),
    ).toBe('edit');
  });

  it('明确的测试诉求仍为 test', () => {
    expect(inferIntent('跑一下 vitest，把失败用例修掉')).toBe('test');
    expect(inferIntent('npm test 失败了')).toBe('test');
  });

  it('纯分析报错 → question，非 debug', () => {
    expect(inferIntent('分析一下为什么报错')).toBe('question');
  });

  it('分析并查看代码 → inspect', () => {
    expect(inferIntent('解释一下 src/harness.ts 里这段逻辑')).toBe('inspect');
  });
});
