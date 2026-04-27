/**
 * memory-security 单元测试。
 * 覆盖 7 种路径攻击向量 + 辅助函数。
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  validatePath,
  isWithinMemoryDir,
  sanitizePathKey,
  PathTraversalError,
} from './memory-security.js';

const ALLOWED_DIR = path.resolve('./test-memory-dir');

describe('validatePath', () => {
  it('接受合法的相对路径', () => {
    const result = validatePath('user_role.md', ALLOWED_DIR);
    expect(result).toBe(path.join(ALLOWED_DIR, 'user_role.md'));
  });

  it('接受子目录中的文件', () => {
    const result = validatePath('sub/file.md', ALLOWED_DIR);
    expect(result).toBe(path.join(ALLOWED_DIR, 'sub', 'file.md'));
  });

  it('拒绝 null byte 注入', () => {
    expect(() => validatePath('file\0.md', ALLOWED_DIR)).toThrow(PathTraversalError);
    expect(() => validatePath('file\0.md', ALLOWED_DIR)).toThrow('Null byte');
  });

  it('拒绝路径遍历 (../)', () => {
    expect(() => validatePath('../etc/passwd', ALLOWED_DIR)).toThrow(PathTraversalError);
    expect(() => validatePath('../../secret.txt', ALLOWED_DIR)).toThrow('escapes allowed directory');
  });

  it('拒绝 URL 编码遍历 (%2e%2e%2f)', () => {
    expect(() => validatePath('%2e%2e%2fpasswd', ALLOWED_DIR)).toThrow(PathTraversalError);
    expect(() => validatePath('%2e%2e/secret', ALLOWED_DIR)).toThrow('URL-encoded traversal');
  });

  it('拒绝绝对路径', () => {
    const absPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';
    expect(() => validatePath(absPath, ALLOWED_DIR)).toThrow(PathTraversalError);
  });

  it('在非 Windows 系统上拒绝反斜杠', () => {
    if (path.sep !== '\\') {
      expect(() => validatePath('sub\\file.md', ALLOWED_DIR)).toThrow(PathTraversalError);
      expect(() => validatePath('sub\\file.md', ALLOWED_DIR)).toThrow('Backslash');
    }
  });
});

describe('isWithinMemoryDir', () => {
  it('目录内的路径返回 true', () => {
    expect(isWithinMemoryDir(path.join(ALLOWED_DIR, 'file.md'), ALLOWED_DIR)).toBe(true);
    expect(isWithinMemoryDir(path.join(ALLOWED_DIR, 'sub', 'file.md'), ALLOWED_DIR)).toBe(true);
  });

  it('目录本身返回 true', () => {
    expect(isWithinMemoryDir(ALLOWED_DIR, ALLOWED_DIR)).toBe(true);
  });

  it('目录外的路径返回 false', () => {
    expect(isWithinMemoryDir(path.resolve('./other-dir/file.md'), ALLOWED_DIR)).toBe(false);
    expect(isWithinMemoryDir(path.resolve('../file.md'), ALLOWED_DIR)).toBe(false);
  });
});

describe('sanitizePathKey', () => {
  it('接受合法的键', () => {
    expect(sanitizePathKey('user_role')).toBe('user_role');
    expect(sanitizePathKey('feedback-testing')).toBe('feedback-testing');
  });

  it('拒绝 null byte', () => {
    expect(() => sanitizePathKey('key\0')).toThrow(PathTraversalError);
  });

  it('拒绝 URL 编码遍历', () => {
    expect(() => sanitizePathKey('%2e%2e%2f')).toThrow(PathTraversalError);
  });

  it('拒绝反斜杠', () => {
    expect(() => sanitizePathKey('sub\\key')).toThrow(PathTraversalError);
  });

  it('拒绝绝对路径', () => {
    expect(() => sanitizePathKey('/etc/passwd')).toThrow(PathTraversalError);
  });
});
