import { describe, expect, it } from 'vitest';

import {
  buildIncompleteContinuationPrompt,
  checkpointHasPendingWork,
  hasPendingWork,
  isReasoningOnlyResponse,
} from '../../src/harness/incomplete-completion.js';
import type { ProjectCheckpointV3 } from '../../src/types/runtime-checkpoint.js';

describe('hasPendingWork', () => {
  it('is false when engineering test failed (no hard block)', () => {
    expect(hasPendingWork({
      goal: 'x', intent: 'edit', phase: 'verification',
      filesRead: [], filesChanged: ['a.ts'],
      commandsRun: ['npm test'],
    })).toBe(false);
  });

  it('is false for engineering-only when tests passed', () => {
    expect(hasPendingWork({
      goal: 'x', intent: 'edit', phase: 'verification',
      filesRead: [], filesChanged: ['src/a.ts'],
      commandsRun: ['npm test'],
    })).toBe(false);
  });

  it('is false when deliverables are already confirmed', () => {
    expect(hasPendingWork({
      goal: 'x', intent: 'edit', phase: 'verification',
      filesRead: [], filesChanged: ['src/a.ts'],
      commandsRun: ['npm test'],
      fileDeliverableWriteVersions: { 'src/a.ts': 1 },
      fileDeliverableConfirmVersions: { 'src/a.ts': 1 },
    })).toBe(false);
  });

  it('is false for engineering-only while tests not run', () => {
    expect(hasPendingWork({
      goal: 'x', intent: 'edit', phase: 'verification',
      filesRead: [], filesChanged: ['src/a.ts'],
      commandsRun: [],
    })).toBe(false);
  });

  it('is false when npm test passed', () => {
    expect(hasPendingWork({
      goal: 'update readme', intent: 'edit', phase: 'verification',
      filesRead: [], filesChanged: ['README.md', 'src/a.ts'],
      commandsRun: ['npm test'],
    })).toBe(false);
  });

  it('is false for file deliverable only', () => {
    expect(hasPendingWork({
      goal: 'x', intent: 'edit', phase: 'editing',
      filesRead: ['C:\\Desktop\\doc.md'],
      filesChanged: ['C:\\Desktop\\doc.md'],
      commandsRun: [],
    })).toBe(false);
  });

  it('is true when write deliverable goal has no files yet', () => {
    expect(hasPendingWork({
      goal: '整理 ant design 成 md 文档放到桌面', intent: 'docs', phase: 'intent',
      filesRead: [], filesChanged: [],
      commandsRun: [],
    })).toBe(true);
  });

  it('is false for chat-only report goal without file deliverable intent', () => {
    expect(hasPendingWork({
      goal: '生成测试报告', intent: 'edit', phase: 'intent',
      filesRead: [], filesChanged: [],
      commandsRun: [],
    })).toBe(false);
  });
});

describe('buildIncompleteContinuationPrompt', () => {
  const emptyRepo = {
    filesRead: [], filesChanged: [], commandsRun: [],
    testCommands: [], recentDiagnostics: [],
  };

  it('prompts the unresolved result without prescribing a tool', () => {
    const prompt = buildIncompleteContinuationPrompt(
      {
        goal: '整理 ant design 成 md 文档放到桌面', intent: 'docs', phase: 'intent',
        filesRead: [], filesChanged: [],
        commandsRun: [],
      },
      emptyRepo,
    );
    expect(prompt).toMatch(/produce the requested result/i);
    expect(prompt).not.toMatch(/write_file|edit_file|run tests/i);
  });

  it('does not prompt tests for md-only changes', () => {
    const prompt = buildIncompleteContinuationPrompt(
      {
        goal: '写文档', intent: 'docs', phase: 'editing',
        filesRead: [], filesChanged: ['/tmp/out.md'],
        commandsRun: [],
      },
      emptyRepo,
    );
    expect(prompt).not.toMatch(/unit tests/i);
  });

  it('does not infer a hard check from changed-item metadata', () => {
    const prompt = buildIncompleteContinuationPrompt(
      {
        goal: 'fix bug', intent: 'edit', phase: 'editing',
        filesRead: [], filesChanged: ['src/a.ts'],
        commandsRun: [],
      },
      emptyRepo,
    );
    expect(prompt).not.toMatch(/unit tests|src\/a\.ts/i);
    expect(prompt).toMatch(/available tools/i);
  });

  it('does not restore the legacy failed-check gate', () => {
    const prompt = buildIncompleteContinuationPrompt(
      {
        goal: 'fix bug', intent: 'edit', phase: 'verification',
        filesRead: [], filesChanged: ['src/a.ts'],
        commandsRun: ['npm test'],
      },
      emptyRepo,
    );
    expect(prompt).not.toMatch(/fix failing tests/i);
  });
});

describe('checkpointHasPendingWork', () => {
  it('uses V3 required blockers and ignores diagnostics alone', () => {
    const cp = {
      version: 3,
      identity: { checkpointId: 'c', projectId: 'p', sessionId: 's' },
      execution: {
        taskState: {
          goal: '继续', intent: 'question', phase: 'editing',
          filesRead: [], filesChanged: ['a.ts'], commandsRun: ['npm test'],
        },
        loopState: {
          currentRound: 1, totalToolCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
          lastInputTokens: 0, lastOutputTokens: 0, startTime: 0,
        },
      },
      completion: { conditions: [], operationOutcomes: [] },
      conversation: { messages: [] },
      workspace: {
        root: '',
        repoContext: {
          filesRead: [], filesChanged: ['a.ts'], commandsRun: ['npm test'],
          testCommands: ['npm test'], recentDiagnostics: ['run_command: exit 1'],
        },
      },
      memory: {},
      snapshotMeta: { capturedAt: '2026-09-09T00:00:00.000Z', trigger: 'manual' },
      extensions: {},
      migration: null,
    } satisfies ProjectCheckpointV3;
    expect(checkpointHasPendingWork(cp)).toBe(false);

    cp.completion.conditions.push({
      id: 'required:test', label: 'test', required: true, status: 'pending',
      source: 'user', sourceRef: 'user:test', evidenceRefs: [],
    });
    expect(checkpointHasPendingWork(cp)).toBe(true);

    cp.completion.conditions[0] = {
      ...cp.completion.conditions[0],
      status: 'satisfied',
      evidenceRefs: ['tool:test'],
    };
    cp.completion.operationOutcomes.push({
      toolCallId: 'tool:test',
      toolName: 'run_command',
      status: 'completed',
      effect: 'execute',
      risk: 'low',
      disposition: 'executed',
      scope: 'verification:test',
      at: 1,
    });
    expect(checkpointHasPendingWork(cp)).toBe(false);

    cp.execution.taskState.goal = '整理 ant design 成 md 文档放到桌面';
    cp.execution.taskState.intent = 'docs';
    cp.execution.taskState.filesChanged = [];
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
