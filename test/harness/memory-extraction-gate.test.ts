import { describe, it, expect } from 'vitest';
import {
  evaluateMemoryExtractionGate,
  hasExtractionSignalWord,
  isOpsTaskContext,
} from '../../src/harness/memory-extraction-gate.js';
import {
  DEFAULT_CASUAL_EXTRACTION_CONFIG,
  DEFAULT_EXTRACTION_REMOTE_CONFIG,
} from '../../src/memory/file-memory/memory-config.js';

const base = {
  turnCount: 5,
  currentUserMessage: '帮我看看这个函数',
  totalInputTokens: 8000,
  sessionHasToolCalls: true,
  toolCallsSinceLastExtract: 5,
  extractionTurnCounter: 1,
  sessionSuccessfulExtractCount: 0,
  sessionExtractWrittenCount: 0,
  extractionConfig: { ...DEFAULT_EXTRACTION_REMOTE_CONFIG },
  casualConfig: { ...DEFAULT_CASUAL_EXTRACTION_CONFIG },
};

describe('memory-extraction-gate', () => {
  it('信号词立即允许', () => {
    expect(hasExtractionSignalWord('记住，commit 用中文')).toBe(true);
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        currentUserMessage: '记住，commit 用中文',
      }).allow,
    ).toBe(true);
  });

  it('信号词在会话已成功 Extract 后仍受 cap 限制', () => {
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        currentUserMessage: '记住，commit 用中文',
        sessionSuccessfulExtractCount: 1,
      }).allow,
    ).toBe(false);
  });

  it('mysql 关键词 alone 不触发（非 ops 安装语境）', () => {
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        turnCount: 1,
        currentUserMessage: '写一个 mysql 查询',
        totalInputTokens: 100,
        toolCallsSinceLastExtract: 0,
      }).allow,
    ).toBe(false);
  });

  it('ops 安装任务默认跳过 Extract', () => {
    expect(isOpsTaskContext('用 zip 安装 mysql')).toBe(true);
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        currentUserMessage: '用 zip 安装 mysql 8',
        commandsRun: ['unzip mysql.zip'],
      }).allow,
    ).toBe(false);
  });

  it('test 任务下纯 npm install 不判 ops', () => {
    expect(isOpsTaskContext('修复单测依赖', ['npm install'], 'test')).toBe(false);
  });

  it('ops 任务中用户纠正（信号词）仍可提取', () => {
    expect(hasExtractionSignalWord('不对，Smart Mode 被拦时要走审批卡片')).toBe(true);
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        currentUserMessage: '不对，Smart Mode 被拦时要走审批卡片',
        commandsRun: ['docker pull mysql'],
      }).allow,
    ).toBe(true);
  });

  it('会话已成功 Extract 一次后不再深度提取', () => {
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        sessionSuccessfulExtractCount: 1,
      }).allow,
    ).toBe(false);
  });

  it('深度门控需要 minTokens 与 toolCallInterval', () => {
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        totalInputTokens: 100,
        toolCallsSinceLastExtract: 0,
      }).allow,
    ).toBe(false);

    expect(
      evaluateMemoryExtractionGate({
        ...base,
        totalInputTokens: 8000,
        toolCallsSinceLastExtract: 5,
      }).allow,
    ).toBe(true);
  });
});
