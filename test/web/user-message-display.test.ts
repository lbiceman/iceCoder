/**
 * 用户消息展示字段：@ 引用文件 / # 技能 / /shell 拆分
 */

import { describe, it, expect } from 'vitest';
import { buildUserMessageDisplayFields } from '../../src/web/user-message-display.js';

describe('buildUserMessageDisplayFields', () => {
  it('keeps explicit @ file refs as referencePaths and strips path lines from content', () => {
    const ref = 'D:\\work\\demo\\readme.txt';
    const result = buildUserMessageDisplayFields(
      `#skill.md\n${ref}\n请总结这个文件`,
      [ref],
      ['skill.md'],
    );

    expect(result.referencePaths).toEqual([ref]);
    expect(result.skills).toEqual(['skill.md']);
    expect(result.content).toBe('请总结这个文件');
    expect(result.content).not.toContain('readme.txt');
  });

  it('splits /shell with @ refs and prompt body', () => {
    const ref = 'C:\\tmp\\config.json';
    const result = buildUserMessageDisplayFields(
      `#登录考试服务器.md\n${ref}\n/shell\n服务器地址: 192.168.1.1`,
      [ref],
      ['登录考试服务器.md'],
    );

    expect(result.shellCommand).toBe('/shell');
    expect(result.referencePaths).toEqual([ref]);
    expect(result.skills).toEqual(['登录考试服务器.md']);
    expect(result.content).toBe('服务器地址: 192.168.1.1');
  });

  it('extracts absolute path lines when referencePaths not passed explicitly', () => {
    const ref = '/home/user/notes.md';
    const result = buildUserMessageDisplayFields(`${ref}\n分析一下`);

    expect(result.referencePaths).toEqual([ref]);
    expect(result.content).toBe('分析一下');
  });

  it('does not treat /open as an @ file ref, and splits it into openCommand', () => {
    const result = buildUserMessageDisplayFields(
      '/open\n\n【目录浏览】若用户只给出文件名',
    );
    expect(result.openCommand).toBe('/open');
    expect(result.referencePaths).toBeUndefined();
    expect(result.content).toBe('【目录浏览】若用户只给出文件名');
  });
});
