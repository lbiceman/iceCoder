import { describe, it, expect } from 'vitest';
import {
  evaluateMemoryExtractionGate,
  hasExtractionSignalWord,
  hasImmediateExtractSignal,
  isOpsTaskContext,
  isUserFeedbackSignal,
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

  it('ops 验收说明里的「不要写长期记忆」不突破 ops 门控', () => {
    const turn1Style = [
      '模拟 zip 安装 MySQL，写入 session-notes，不要写长期记忆。',
      '本轮用户侧不使用记忆指令，勿在回复中写入长期记忆文件。',
    ].join('\n');
    expect(hasExtractionSignalWord(turn1Style)).toBe(true);
    expect(hasImmediateExtractSignal(turn1Style)).toBe(false);
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        currentUserMessage: turn1Style,
        commandsRun: ['docker pull mysql:8.0'],
      }),
    ).toEqual({ allow: false, reason: 'ops_task' });
  });

  it('test 任务下纯 npm install 不判 ops', () => {
    expect(isOpsTaskContext('修复单测依赖', ['npm install'], 'test')).toBe(false);
  });

  it('ops 任务中用户纠正（feedback）仍可提取', () => {
    const turn2Correction =
      '不对，以后 Smart Mode 拦截 shell 或 docker 命令时，不要绕路硬跑；必须走原生审批卡片让用户点批准，批准后再重试同一条命令。';
    expect(isUserFeedbackSignal(turn2Correction)).toBe(true);
    expect(hasImmediateExtractSignal(turn2Correction)).toBe(true);
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        currentUserMessage: turn2Correction,
        commandsRun: ['docker pull mysql'],
      }),
    ).toEqual({ allow: true, reason: 'user_feedback' });
  });

  it('Turn 2 完整验收提示词（纠正句在引号内、前有场景说明）仍识别 feedback', () => {
    const turn2Full = [
      '继续 MySQL 安装场景（仍在 ops 语境）。',
      '',
      '安装过程中 Smart Mode 把 docker pull 拦了。我的纠正如下——这是可复用的工作流，不是安装进度：',
      '',
      '「不对，以后 Smart Mode / Auto-review 拦截 shell 或 docker 命令时，不要绕路硬跑；必须走原生审批卡片让用户点批准，批准后再重试同一条命令。」',
      '',
      '请：',
      '1. 把这条纠正写入 session-notes 的 Errors & Corrections。',
      '2. 不要 write_file 到 memory-files（本轮我没有说「记住」）。',
    ].join('\n');

    expect(isUserFeedbackSignal(turn2Full)).toBe(true);
    expect(hasImmediateExtractSignal(turn2Full)).toBe(true);
    expect(
      evaluateMemoryExtractionGate({
        ...base,
        currentUserMessage: turn2Full,
        commandsRun: ['docker pull mysql:8.0'],
      }),
    ).toEqual({ allow: true, reason: 'user_feedback' });
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
