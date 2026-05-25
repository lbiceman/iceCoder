import type { UnifiedMessage } from '../llm/types.js';
import type { TaskCheckpoint } from './checkpoint.js';
import type { ContextCompactor } from './context-compactor.js';
import { isSyntheticUserBlockContent } from './compaction-strategy.js';
import { isSystemInjectedUserContent } from './harness-message-utils.js';
import type { HarnessRunState } from './harness-run-state.js';
import { isPoisonedGoal } from './session-goal-anchor.js';
import { hasExecutableSideSignal } from './task-state.js';

const RESUME_CHECKPOINT_OPEN = '<resume-checkpoint>';
const RESUME_CHECKPOINT_BLOCK_RE = /<resume-checkpoint>[\s\S]*?<\/resume-checkpoint>/gi;
const SYNTHETIC_BLOCK_RES = /<(?:system-reminder|context-summary|compact_boundary|recent-dialogue-focus|runtime-recovery-context|recent-file-contents|system-context|resume-checkpoint)>[\s\S]*?<\/[^>]+>/gi;

/** 与 {@link resolveEffectiveUserGoal} 对齐的 anchor 最小长度 */
export const MIN_SUBSTANTIAL_ANCHOR_CHARS = 80;

function stripSyntheticBlocks(goal: string): string {
  let cleaned = goal.replace(RESUME_CHECKPOINT_BLOCK_RE, '').trim();
  cleaned = cleaned.replace(SYNTHETIC_BLOCK_RES, '').trim();
  if (isSyntheticUserBlockContent(cleaned)) return '';
  return cleaned;
}

/** 去掉 goal 中嵌套的历史 resume-checkpoint / 合成块，避免 checkpoint 文件越套越大。 */
export function sanitizeCheckpointGoal(goal: string): string {
  const stripped = stripSyntheticBlocks(goal);
  if (stripped && stripped.length >= MIN_SUBSTANTIAL_ANCHOR_CHARS) return stripped;
  if (stripped && hasExecutableSideSignal(stripped)) return stripped.slice(0, 4000);

  if (!goal.includes(RESUME_CHECKPOINT_OPEN) && stripped === goal.trim()) {
    if (isPoisonedGoal(goal)) return '(checkpoint goal unavailable)';
    return goal.trim().slice(0, 4000);
  }

  const before = goal.includes(RESUME_CHECKPOINT_OPEN)
    ? goal.slice(0, goal.indexOf(RESUME_CHECKPOINT_OPEN)).trim()
    : '';
  const beforeClean = stripSyntheticBlocks(before);
  if (beforeClean.length >= MIN_SUBSTANTIAL_ANCHOR_CHARS) return beforeClean;
  if (beforeClean.length > 0 && hasExecutableSideSignal(beforeClean)) return beforeClean.slice(0, 4000);

  if (stripped.length > 0) {
    return isPoisonedGoal(stripped) ? '(checkpoint goal unavailable)' : stripped.slice(0, 4000);
  }
  if (beforeClean.length > 0) {
    return isPoisonedGoal(beforeClean) ? '(checkpoint goal unavailable)' : beforeClean.slice(0, 4000);
  }
  return '(checkpoint goal unavailable)';
}

export function isResumeCheckpointContent(content: string): boolean {
  return content.trimStart().startsWith(RESUME_CHECKPOINT_OPEN);
}

/** 短摘要注入 LLM（完整 JSON 仅留磁盘）。 */
export function buildCheckpointResumeSummary(checkpoint: TaskCheckpoint): string {
  const goalPreview = sanitizeCheckpointGoal(checkpoint.taskState.goal)
    .replace(/\s+/g, ' ')
    .slice(0, 600);
  const filesChanged = checkpoint.repoContext.filesChanged.slice(-15);
  const diagnostics = checkpoint.repoContext.recentDiagnostics.slice(-5);
  const failed = checkpoint.failedToolCalls.slice(-10);
  const testCommands = checkpoint.repoContext.testCommands.slice(-3);

  const lines = [
    RESUME_CHECKPOINT_OPEN,
    'Previous run paused. This block is the authoritative resume state (do not expect full checkpoint JSON in chat).',
    '',
    `phase: ${checkpoint.phase}`,
    `status: ${checkpoint.status}`,
    `stopReason: ${checkpoint.stopReason ?? 'unknown'} @ harness round ${checkpoint.loop.currentRound}`,
    `toolCalls: ${checkpoint.loop.totalToolCalls}`,
    '',
    `lastCompleted: ${checkpoint.lastCompletedStep ?? '(none)'}`,
    `nextStep: ${checkpoint.nextSuggestedStep ?? 'Continue verification and fix remaining failures.'}`,
    '',
    'taskGoalPreview:',
    goalPreview || '(see workspace task prompt)',
    '',
  ];

  if (filesChanged.length > 0) {
    lines.push(`filesChanged (${filesChanged.length}): ${filesChanged.join(', ')}`);
  }
  if (testCommands.length > 0) {
    lines.push(`recentTests: ${testCommands.join(' | ')}`);
  }
  if (diagnostics.length > 0) {
    lines.push('recentDiagnostics:');
    for (const d of diagnostics) lines.push(`- ${d}`);
  }
  if (failed.length > 0) {
    lines.push('failedTools (recent):');
    for (const f of failed) lines.push(`- ${f}`);
  }

  lines.push(
    '',
    'Resume rules: follow nextStep; read failing tests/source before rerunning blocked commands; do not ask user to continue.',
    '</resume-checkpoint>',
  );

  return lines.join('\n');
}

export function stripResumeCheckpointMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  return messages.filter(m => {
    if (m.role !== 'user' || typeof m.content !== 'string') return true;
    return !isResumeCheckpointContent(m.content);
  });
}

/** 各 provider 通用的 context / token 超限文案（不匹配裸数字错误码如 line 2013） */
const CONTEXT_WINDOW_ERROR_PATTERNS: readonly RegExp[] = [
  /context window exceeds/i,
  /context_length_exceeded/i,
  /maximum context length/i,
  /max(?:imum)?\s+(?:context|model)\s+(?:length|tokens?)/i,
  /(?:prompt|input|messages?).{0,48}(?:too long|too large|exceeds?(?:\s+the)?\s+(?:limit|maximum|max))/i,
  /(?:too many|exceeds?).{0,24}tokens?/i,
  /tokens?.{0,32}(?:limit|maximum|max).{0,24}exceed/i,
  /reduce the length of the (?:messages|prompt|input)/i,
];

export function isContextWindowExceededError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return CONTEXT_WINDOW_ERROR_PATTERNS.some(pattern => pattern.test(msg));
}

/** Fork / emergency 后首轮：maybeCompact 在 turnCount 递增前调用 */
export function shouldSkipCompactionOnPostForkRound(state: HarnessRunState): boolean {
  return (state.checkpointResumeForkApplied || state.contextEmergencyCompactUsed) && state.turnCount === 0;
}

/** Fork / emergency 后首轮：injectMemoryContext 在 turnCount 递增后调用 */
export function shouldSkipMemoryRecallOnPostForkRound(state: HarnessRunState): boolean {
  return (state.checkpointResumeForkApplied || state.contextEmergencyCompactUsed) && state.turnCount === 1;
}

/** Emergency fork 优先复用 checkpoint 短摘要，否则退回通用 recovery 块 */
export function buildEmergencyResumeSummaryMessage(
  checkpointSummary?: UnifiedMessage,
): UnifiedMessage {
  if (checkpointSummary && typeof checkpointSummary.content === 'string') {
    return {
      role: 'user',
      content: [
        checkpointSummary.content,
        '',
        '[Emergency: provider rejected prompt size; conversation history was locally trimmed. Follow the resume block above.]',
      ].join('\n'),
      preserveOnCompaction: true,
    };
  }
  return {
    role: 'user',
    content: [
      '<runtime-recovery-context>',
      'Emergency local context trim: provider rejected the prompt for exceeding context window.',
      'Continue from the latest user instruction and structured runtime state.',
      'Read failing tests/source before rerunning verification commands.',
      '</runtime-recovery-context>',
    ].join('\n'),
    preserveOnCompaction: true,
  };
}

/** 找首条实质性用户任务（续跑 anchor）。 */
export function findCheckpointAnchorIndex(messages: UnifiedMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const content = msg.content;
    if (isSyntheticUserBlockContent(content)) continue;
    if (isSystemInjectedUserContent(content)) continue;
    if (isResumeCheckpointContent(content)) continue;
    const trimmed = content.trim();
    if (trimmed.length >= MIN_SUBSTANTIAL_ANCHOR_CHARS || hasExecutableSideSignal(trimmed)) {
      return i;
    }
  }
  return -1;
}

export interface CheckpointResumeForkResult {
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  applied: boolean;
}

/** 续跑 Pre-flight：去掉历史 resume 块 + 本地 Fork（零 LLM）。 */
export function applyCheckpointResumeFork(
  compactor: ContextCompactor,
  messages: UnifiedMessage[],
  resumeSummary: UnifiedMessage,
  options?: { aggressive?: boolean },
): CheckpointResumeForkResult {
  const beforeMessages = messages.length;
  const beforeTokens = compactor.getEstimatedTokens(messages);
  const filtered = stripResumeCheckpointMessages(messages);
  const forked = compactor.compactForCheckpointResume(filtered, resumeSummary, options);
  messages.length = 0;
  messages.push(...forked);
  const afterMessages = messages.length;
  const afterTokens = compactor.getEstimatedTokens(messages);
  const applied = afterMessages < beforeMessages || afterTokens < beforeTokens;
  return {
    beforeMessages,
    afterMessages,
    beforeTokens,
    afterTokens,
    applied,
  };
}
