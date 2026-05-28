import { describe, expect, it } from 'vitest';

import {
  buildIncompleteContinuationPrompt,
  checkpointHasPendingWork,
  hasPendingWork,
  isReasoningOnlyResponse,
} from '../../src/harness/incomplete-completion.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';

describe('hasPendingWork', () => {
  it('is true when verification failed after test command', () => {
    expect(hasPendingWork(
      {
        goal: 'x', intent: 'edit', phase: 'verification',
        filesRead: [], filesChanged: ['a.ts'],
        commandsRun: ['npm test'], verificationRequired: true, verificationStatus: 'failed',
      },
      {
        filesRead: [], filesChanged: ['a.ts'], commandsRun: ['npm test'],
        testCommands: ['npm test'], recentDiagnostics: ['run_command: exit 1'],
      },
    )).toBe(true);
  });

  it('is true when verification failed', () => {
    expect(hasPendingWork(
      {
        goal: 'x', intent: 'edit', phase: 'verification',
        filesRead: [], filesChanged: ['a.ts'],
        commandsRun: [], verificationRequired: true, verificationStatus: 'failed',
      },
      {
        filesRead: [], filesChanged: [], commandsRun: [],
        testCommands: [], recentDiagnostics: [],
      },
    )).toBe(true);
  });

  it('is false when verification passed and no diagnostics', () => {
    expect(hasPendingWork(
      {
        goal: 'x', intent: 'edit', phase: 'verification',
        filesRead: [], filesChanged: ['a.ts'],
        commandsRun: [], verificationRequired: true, verificationStatus: 'passed',
      },
      {
        filesRead: [], filesChanged: [], commandsRun: [],
        testCommands: [], recentDiagnostics: [],
      },
    )).toBe(false);
  });

  it('is false for file deliverable when verification already passed', () => {
    expect(hasPendingWork(
      {
        goal: 'x', intent: 'edit', phase: 'verification',
        filesRead: ['C:\\Desktop\\doc.md'],
        filesChanged: ['C:\\Desktop\\doc.md'],
        commandsRun: [], verificationRequired: true, verificationStatus: 'passed',
      },
      {
        filesRead: ['C:\\Desktop\\doc.md'], filesChanged: ['C:\\Desktop\\doc.md'],
        commandsRun: [], testCommands: [], recentDiagnostics: [],
      },
    )).toBe(false);
  });

  it('is true for file deliverable while verification still required', () => {
    expect(hasPendingWork(
      {
        goal: 'x', intent: 'edit', phase: 'editing',
        filesRead: ['C:\\Desktop\\doc.md'],
        filesChanged: ['C:\\Desktop\\doc.md'],
        commandsRun: [], verificationRequired: true, verificationStatus: 'required',
      },
      {
        filesRead: ['C:\\Desktop\\doc.md'], filesChanged: ['C:\\Desktop\\doc.md'],
        commandsRun: [], testCommands: [], recentDiagnostics: [],
      },
    )).toBe(true);
  });

  it('is true when write deliverable goal has no files yet', () => {
    expect(hasPendingWork(
      {
        goal: '整理 ant design 成 md 文档放到桌面', intent: 'docs', phase: 'intent',
        filesRead: [], filesChanged: [],
        commandsRun: [], verificationRequired: false, verificationStatus: 'not_required',
      },
      {
        filesRead: [], filesChanged: [], commandsRun: [],
        testCommands: [], recentDiagnostics: [],
      },
    )).toBe(true);
  });

  it('is false for chat-only report goal without file deliverable intent', () => {
    expect(hasPendingWork(
      {
        goal: '生成测试报告', intent: 'edit', phase: 'intent',
        filesRead: [], filesChanged: [],
        commandsRun: [], verificationRequired: false, verificationStatus: 'not_required',
      },
      {
        filesRead: [], filesChanged: [], commandsRun: [],
        testCommands: [], recentDiagnostics: [],
      },
    )).toBe(false);
  });
});

describe('buildIncompleteContinuationPrompt', () => {
  const emptyRepo = {
    filesRead: [], filesChanged: [], commandsRun: [],
    testCommands: [], recentDiagnostics: [],
  };

  it('prompts write_file + file_info when deliverable not written yet', () => {
    const prompt = buildIncompleteContinuationPrompt(
      {
        goal: '整理 ant design 成 md 文档放到桌面', intent: 'docs', phase: 'intent',
        filesRead: [], filesChanged: [],
        commandsRun: [], verificationRequired: false, verificationStatus: 'not_required',
      },
      emptyRepo,
    );
    expect(prompt).toMatch(/write_file|edit_file/i);
    expect(prompt).toMatch(/file_info|read_file/i);
    expect(prompt).not.toMatch(/Run tests/i);
  });

  it('prompts file_info for pending file_deliverable changes', () => {
    const prompt = buildIncompleteContinuationPrompt(
      {
        goal: '写文档', intent: 'docs', phase: 'editing',
        filesRead: [], filesChanged: ['/tmp/out.md'],
        commandsRun: [], verificationRequired: true, verificationStatus: 'required',
      },
      emptyRepo,
    );
    expect(prompt).toMatch(/file_info|read_file/i);
    expect(prompt).not.toMatch(/Run tests/i);
  });

  it('prompts run tests for engineering pending work', () => {
    const prompt = buildIncompleteContinuationPrompt(
      {
        goal: 'fix bug', intent: 'edit', phase: 'editing',
        filesRead: [], filesChanged: ['src/a.ts'],
        commandsRun: [], verificationRequired: true, verificationStatus: 'required',
      },
      emptyRepo,
    );
    expect(prompt).toMatch(/Run tests/i);
  });
});

describe('checkpointHasPendingWork', () => {
  it('reopens completed checkpoints with pending diagnostics', () => {
    const cp = {
      version: 1,
      taskId: 't',
      status: 'completed',
      userGoal: '继续',
      phase: 'editing',
      taskState: {
        goal: '继续', intent: 'question' as const, phase: 'editing' as const,
        filesRead: [], filesChanged: ['a.ts'],
        commandsRun: ['npm test'], verificationRequired: true, verificationStatus: 'failed' as const,
      },
      repoContext: {
        filesRead: [], filesChanged: ['a.ts'], commandsRun: ['npm test'],
        testCommands: ['npm test'], recentDiagnostics: ['run_command: exit 1'],
      },
      failedToolCalls: [],
      messageCount: 1,
      loop: { currentRound: 1, totalToolCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 },
      createdAt: '', updatedAt: '',
    } satisfies TaskCheckpoint;
    expect(checkpointHasPendingWork(cp)).toBe(true);
  });
});

describe('isReasoningOnlyResponse', () => {
  it('detects reasoning without content or tools', () => {
    expect(isReasoningOnlyResponse({
      content: '',
      reasoningContent: 'I need to fix manifest.json',
      finishReason: 'stop',
    })).toBe(true);
  });

  it('returns false when tools present', () => {
    expect(isReasoningOnlyResponse({
      content: '',
      reasoningContent: 'thinking',
      toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'a.ts' } }],
      finishReason: 'stop',
    })).toBe(false);
  });
});
