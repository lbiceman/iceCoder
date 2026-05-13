/**
 * 文件浏览器确定性导航 — 解析辅助函数单测（不调用真实磁盘）。
 */

import { describe, it, expect } from 'vitest';
import {
  detectFileBrowserOpen,
  extractWindowsAbsolutePaths,
  inferLastBrowsedDir,
  looksLikeBrowserNavigation,
  looksLikeFileAnalysisIntent,
  parseDriveLetterIntent,
} from '../../src/web/file-browser-direct.js';

describe('file-browser-direct helpers', () => {
  it('detectFileBrowserOpen', () => {
    expect(detectFileBrowserOpen('~open\n【文件浏览器模式】')).toBe(true);
    expect(detectFileBrowserOpen('~open\n【目录列举】')).toBe(true);
    expect(detectFileBrowserOpen('~open\n[Directory browsing] shortcut')).toBe(true);
    expect(detectFileBrowserOpen('~open\n【目录浏览】')).toBe(true);
    expect(detectFileBrowserOpen('聊聊别的')).toBe(false);
  });

  it('extractWindowsAbsolutePaths', () => {
    expect(extractWindowsAbsolutePaths('x D:\\work\\self\\ice-excel\\readme.md y')).toContain(
      'D:\\work\\self\\ice-excel\\readme.md',
    );
    expect(extractWindowsAbsolutePaths('prefix D: suffix')).toContain('D:\\');
  });

  it('parseDriveLetterIntent', () => {
    expect(parseDriveLetterIntent('进入D盘')).toBe('D:\\');
    expect(parseDriveLetterIntent('打开 D')).toBe('D:\\');
    expect(parseDriveLetterIntent('你好')).toBeNull();
  });

  it('inferLastBrowsedDir', () => {
    expect(inferLastBrowsedDir('D:\\')).toBe('D:\\');
    expect(inferLastBrowsedDir('D:\\foo')).toBe('D:\\foo\\');
  });

  it('looksLikeFileAnalysisIntent', () => {
    expect(looksLikeFileAnalysisIntent('分析一下 ice-excel-demand.pptx')).toBe(true);
    expect(looksLikeFileAnalysisIntent('总结出来')).toBe(true);
    expect(looksLikeFileAnalysisIntent('进入 D 盘')).toBe(false);
  });

  it('looksLikeBrowserNavigation', () => {
    expect(looksLikeBrowserNavigation('D盘')).toBe(true);
    expect(looksLikeBrowserNavigation('进入 D')).toBe(true);
    expect(looksLikeBrowserNavigation('a'.repeat(200))).toBe(false);
  });
});
