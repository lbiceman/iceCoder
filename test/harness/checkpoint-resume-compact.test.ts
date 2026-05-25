import { describe, expect, it } from 'vitest';

import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';
import {
  applyCheckpointResumeFork,
  buildCheckpointResumeSummary,
  buildEmergencyResumeSummaryMessage,
  findCheckpointAnchorIndex,
  isContextWindowExceededError,
  isResumeCheckpointContent,
  sanitizeCheckpointGoal,
  shouldSkipCompactionOnPostForkRound,
  shouldSkipMemoryRecallOnPostForkRound,
  stripResumeCheckpointMessages,
} from '../../src/harness/checkpoint-resume-compact.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function minimalRunState(overrides: Partial<HarnessRunState> = {}): HarnessRunState {
  return {
    messages: [],
    tools: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    reasoningOnlyRecoveryCount: 0,
    prematureCompletionRecoveryCount: 0,
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: undefined as never,
    repoContext: undefined as never,
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    rebuildEscalationInjected: false,
    segmentRenewalCount: 0,
    checkpointResumeForkApplied: false,
    contextEmergencyCompactUsed: false,
    stepReviewedThisRound: false,
    supervisorPhase: 'free',
    filesChangedAtRoundStart: 0,
    branchSwitchedThisRound: false,
    ...overrides,
  };
}

function buildCheckpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return {
    version: 1,
    taskId: 'task-1',
    status: 'paused',
    userGoal: 'implement game',
    phase: 'verification',
    lastCompletedStep: 'npm test partial pass',
    nextSuggestedStep: 'fix build errors',
    stopReason: 'user_checkpoint',
    taskState: {
      goal: 'implement survivors game with npm test and build',
      intent: 'implementation',
      phase: 'verification',
      filesRead: [],
      filesChanged: ['src/MainMenuScene.ts'],
      commandsRun: ['npm test'],
      verificationRequired: true,
      verificationStatus: 'pending',
    },
    repoContext: {
      filesRead: ['src/MainMenuScene.ts'],
      filesChanged: ['src/MainMenuScene.ts'],
      commandsRun: ['npm test', 'npm run build'],
      testCommands: ['npm test'],
      recentDiagnostics: ['build failed: dist missing'],
    },
    failedToolCalls: ['run_command:npm run build'],
    messageCount: 400,
    loop: {
      currentRound: 128,
      totalToolCalls: 200,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function filler(count: number): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `user turn ${i}: ${'x'.repeat(120)}` },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `tc-${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }],
      },
      { role: 'tool', toolCallId: `tc-${i}`, content: 'file body '.repeat(80) },
    );
  }
  return msgs;
}

describe('checkpoint-resume-compact', () => {
  it('sanitizeCheckpointGoal strips nested resume-checkpoint blocks', () => {
    const inner = '<resume-checkpoint>old state</resume-checkpoint>';
    const goal = `Original task goal ${'x'.repeat(100)}\n\n${inner}\n\n${inner}`;
    const cleaned = sanitizeCheckpointGoal(goal);
    expect(cleaned).not.toContain('<resume-checkpoint>');
    expect(cleaned).toContain('Original task goal');
  });

  it('sanitizeCheckpointGoal does not re-embed resume blocks when goal is only resume text', () => {
    const goal = '<resume-checkpoint>only nested</resume-checkpoint>';
    const cleaned = sanitizeCheckpointGoal(goal);
    expect(cleaned).not.toContain('<resume-checkpoint>');
    expect(cleaned).toBe('(checkpoint goal unavailable)');
  });

  it('buildCheckpointResumeSummary is short and does not embed full checkpoint JSON', () => {
    const nestedGoal = `Task ${'y'.repeat(200)}<resume-checkpoint>nested</resume-checkpoint>`;
    const summary = buildCheckpointResumeSummary(buildCheckpoint({
      taskState: {
        ...buildCheckpoint().taskState,
        goal: nestedGoal,
      },
    }));
    expect(isResumeCheckpointContent(summary)).toBe(true);
    expect(summary).toContain('phase: verification');
    expect(summary).toContain('nextStep: fix build errors');
    expect(summary).toContain('MainMenuScene.ts');
    expect(summary.length).toBeLessThan(8000);
    expect(summary).not.toContain('"version": 1');
  });

  it('stripResumeCheckpointMessages removes historical resume blocks only', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'real task '.padEnd(250, 'z') },
      { role: 'user', content: buildCheckpointResumeSummary(buildCheckpoint()) },
      { role: 'assistant', content: 'working' },
    ];
    const stripped = stripResumeCheckpointMessages(messages);
    expect(stripped).toHaveLength(2);
    expect(stripped[0].content).toContain('real task');
  });

  it('findCheckpointAnchorIndex picks first substantive user task', () => {
    const benchmarkGoal = 'E:\\test\\implement-spellbrigade-survivor-second\n\n从零实现 survivors roguelike。'.padEnd(220, 'x');
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '<context-summary>old</context-summary>' },
      { role: 'user', content: benchmarkGoal },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: buildCheckpointResumeSummary(buildCheckpoint()) },
    ];
    expect(findCheckpointAnchorIndex(messages)).toBe(1);
  });

  it('findCheckpointAnchorIndex accepts 80+ char goals aligned with resume-goal', () => {
    const shortGoal = 'implement survivors benchmark task with npm test acceptance'.padEnd(85, '.');
    const messages: UnifiedMessage[] = [
      { role: 'user', content: shortGoal },
      { role: 'assistant', content: 'ok' },
    ];
    expect(findCheckpointAnchorIndex(messages)).toBe(0);
  });

  it('applyCheckpointResumeFork shrinks long histories without LLM', () => {
    const benchmarkGoal = 'E:\\test\\implement-spellbrigade-survivor-second\n\n从零实现 survivors roguelike。'.padEnd(220, 'x');
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: benchmarkGoal },
      ...filler(80),
      { role: 'user', content: buildCheckpointResumeSummary(buildCheckpoint()) },
    ];
    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 20,
      keepRecentMinTokens: 100,
      keepRecentMaxTokens: 50_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
      maxToolResultLength: 500,
    });
    const resumeSummary = {
      role: 'user' as const,
      content: buildCheckpointResumeSummary(buildCheckpoint()),
      preserveOnCompaction: true,
    };

    const beforeTokens = compactor.getEstimatedTokens(messages);
    const fork = applyCheckpointResumeFork(compactor, messages, resumeSummary);
    const afterTokens = compactor.getEstimatedTokens(messages);

    expect(fork.beforeMessages).toBeGreaterThan(fork.afterMessages);
    expect(fork.applied).toBe(true);
    expect(afterTokens).toBeLessThan(beforeTokens);
    expect(messages.some(m => typeof m.content === 'string' && m.content.includes(benchmarkGoal.slice(0, 40)))).toBe(true);
    expect(messages.filter(m => isResumeCheckpointContent(String(m.content ?? '')))).toHaveLength(1);
  });

  it('applyCheckpointResumeFork reports applied=false when history is already minimal', () => {
    const resumeSummary = {
      role: 'user' as const,
      content: buildCheckpointResumeSummary(buildCheckpoint()),
      preserveOnCompaction: true,
    };
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'short task '.padEnd(90, '.') },
      resumeSummary,
    ];
    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 20,
      keepRecentMinTokens: 100,
      keepRecentMaxTokens: 50_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
      maxToolResultLength: 500,
    });

    const fork = applyCheckpointResumeFork(compactor, messages, resumeSummary);
    expect(fork.applied).toBe(false);
  });

  it('buildEmergencyResumeSummaryMessage falls back without checkpoint summary', () => {
    const emergency = buildEmergencyResumeSummaryMessage(undefined);
    expect(String(emergency.content)).toContain('<runtime-recovery-context>');
    expect(String(emergency.content)).not.toContain('<resume-checkpoint>');
  });

  it('isContextWindowExceededError detects provider context window failures', () => {
    expect(isContextWindowExceededError(new Error('OpenAI API Error [400]: context window exceeds limit (2013)'))).toBe(true);
    expect(isContextWindowExceededError(new Error('context_length_exceeded: max 128000'))).toBe(true);
    expect(isContextWindowExceededError(new Error('This model\'s maximum context length is 8192 tokens'))).toBe(true);
    expect(isContextWindowExceededError(new Error('Prompt is too long: 250000 tokens exceed the limit'))).toBe(true);
    expect(isContextWindowExceededError(new Error('Please reduce the length of the messages'))).toBe(true);
    expect(isContextWindowExceededError(new Error('network timeout'))).toBe(false);
    expect(isContextWindowExceededError(new Error('failed at line 2013 in parser'))).toBe(false);
  });

  it('buildEmergencyResumeSummaryMessage prefers checkpoint summary', () => {
    const checkpointSummary = {
      role: 'user' as const,
      content: buildCheckpointResumeSummary(buildCheckpoint()),
      preserveOnCompaction: true,
    };
    const emergency = buildEmergencyResumeSummaryMessage(checkpointSummary);
    expect(emergency.content).toContain('<resume-checkpoint>');
    expect(emergency.content).toContain('Emergency: provider rejected prompt size');
  });

  it('post-fork skip helpers gate compaction and memory on the correct turnCount', () => {
    expect(shouldSkipCompactionOnPostForkRound(minimalRunState({
      checkpointResumeForkApplied: true,
      turnCount: 0,
    }))).toBe(true);
    expect(shouldSkipMemoryRecallOnPostForkRound(minimalRunState({
      checkpointResumeForkApplied: true,
      turnCount: 1,
    }))).toBe(true);
    expect(shouldSkipMemoryRecallOnPostForkRound(minimalRunState({
      checkpointResumeForkApplied: true,
      turnCount: 0,
    }))).toBe(false);
    expect(shouldSkipCompactionOnPostForkRound(minimalRunState({
      contextEmergencyCompactUsed: true,
      turnCount: 0,
    }))).toBe(true);
    expect(shouldSkipMemoryRecallOnPostForkRound(minimalRunState({
      contextEmergencyCompactUsed: true,
      turnCount: 1,
    }))).toBe(true);
  });
});
