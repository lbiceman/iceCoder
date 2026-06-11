/**
 * 记忆整合后台执行器（单飞）。
 *
 * Dream LLM 整合在独立异步任务中运行，不阻塞 HTTP 请求或 harness onLoopEnd。
 * 与 memory-dream 内的 ConsolidationLock / 同进程互斥配合，同时仅允许一个任务。
 */

import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';
import type { DreamResult, DreamTrigger } from './memory-dream.js';
import { createMemoryDream } from './memory-dream.js';
import {
  DREAM_BATCH_MAX_ROUNDS,
  DREAM_CONTINUATION_DELAY_MS,
  DREAM_CONTINUATION_PEAK_DELAY_MS,
} from './memory-config.js';
import { getScannerCache } from './memory-scanner-cache.js';
import { getMemoryTelemetry } from './memory-telemetry.js';

export type DreamJobTrigger = 'manual' | 'auto';

export interface DreamJobStatus {
  running: boolean;
  trigger: DreamJobTrigger | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
  lastSummary: string | null;
  lastExecuted: boolean | null;
  filesModified: number;
  filesDeleted: number;
  filesEvicted: number;
  durationMs: number;
}

export interface ManualDreamBackgroundParams {
  memoryDir: string;
  llmAdapter: LLMAdapterInterface;
  fileCountBefore: number;
  preEvicted: number;
}

export interface AutoDreamBackgroundParams {
  memoryDir: string;
  llmAdapter: LLMAdapterInterface;
  conversationPrefix?: UnifiedMessage[];
  dreamGateTrigger: DreamTrigger | null;
  fileCountBefore: number;
  /** Dream 完成后仅对用户目录做 cap 兜底 */
  onAfterDream?: () => Promise<void>;
}

const idleStatus = (): DreamJobStatus => ({
  running: false,
  trigger: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastSummary: null,
  lastExecuted: null,
  filesModified: 0,
  filesDeleted: 0,
  filesEvicted: 0,
  durationMs: 0,
});

let jobStatus: DreamJobStatus = idleStatus();
let runChain: Promise<void> = Promise.resolve();

/** 当前是否有整合任务在后台运行 */
export function isDreamJobRunning(): boolean {
  return jobStatus.running;
}

/** 测试用：清空串行队列与 job 状态 */
export function resetDreamRunnerChainForTests(): void {
  runChain = Promise.resolve();
  jobStatus = idleStatus();
}

/** 最近一次 / 正在进行的整合任务状态（供 GET /api/memory/dream 轮询） */
export function getDreamJobStatus(): Readonly<DreamJobStatus> {
  return { ...jobStatus };
}

function beginJob(trigger: DreamJobTrigger): void {
  jobStatus = {
    ...idleStatus(),
    running: true,
    trigger,
    startedAt: Date.now(),
  };
}

function finishJob(
  trigger: DreamJobTrigger,
  patch: Partial<DreamJobStatus> & { lastExecuted: boolean; lastSummary: string },
): void {
  jobStatus = {
    ...jobStatus,
    running: false,
    trigger,
    finishedAt: Date.now(),
    lastError: patch.lastError ?? null,
    lastSummary: patch.lastSummary,
    lastExecuted: patch.lastExecuted,
    filesModified: patch.filesModified ?? 0,
    filesDeleted: patch.filesDeleted ?? 0,
    filesEvicted: patch.filesEvicted ?? 0,
    durationMs: patch.durationMs ?? (jobStatus.startedAt ? Date.now() - jobStatus.startedAt : 0),
  };
}

function dreamSummaryLooksLikePeakHour(summary: string): boolean {
  return summary.includes('529') || summary.includes('高峰') || summary.includes('繁忙');
}

function compressDreamSummary(summary: string, maxLen = 480): string {
  if (summary.length <= maxLen) return summary;
  const parts = summary.split(' → ').filter(Boolean);
  if (parts.length <= 2) return `${summary.slice(0, maxLen)}…`;
  const head = parts[0]!;
  const tail = parts.slice(-2).join(' → ');
  const merged = `${head} → … → ${tail}`;
  return merged.length <= maxLen ? merged : `${tail.slice(0, maxLen)}…`;
}

function mergeDreamResults(accum: DreamResult, next: DreamResult): DreamResult {
  const parts = [accum.summary, next.summary].filter(Boolean);
  return {
    executed: accum.executed || next.executed,
    summary: compressDreamSummary(parts.join(' → ')),
    filesModified: accum.filesModified + next.filesModified,
    filesDeleted: accum.filesDeleted + next.filesDeleted,
    filesEvicted: (accum.filesEvicted ?? 0) + (next.filesEvicted ?? 0),
    duration: accum.duration + next.duration,
    batchesRemaining: next.batchesRemaining,
    batchesCompleted: (accum.batchesCompleted ?? 0) + (next.batchesCompleted ?? 0),
    batchesTotal: next.batchesTotal ?? accum.batchesTotal,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 分批整合预算用尽或单批失败时自动衔接，断点文件由 MemoryDream 维护 */
async function runDreamWithBatchContinuations(
  runOnce: () => Promise<DreamResult>,
): Promise<DreamResult> {
  let result = await runOnce();
  for (let round = 1; round < DREAM_BATCH_MAX_ROUNDS && (result.batchesRemaining ?? 0) > 0; round++) {
    const delay = dreamSummaryLooksLikePeakHour(result.summary)
      ? DREAM_CONTINUATION_PEAK_DELAY_MS
      : DREAM_CONTINUATION_DELAY_MS;
    console.log(
      `[MemoryDreamRunner] batch continuation ${round + 1}/${DREAM_BATCH_MAX_ROUNDS}: ` +
      `${result.batchesRemaining} batches remaining, wait ${delay}ms`,
    );
    await sleepMs(delay);
    result = mergeDreamResults(result, await runOnce());
  }
  if ((result.batchesRemaining ?? 0) > 0) {
    result = {
      ...result,
      summary: `${result.summary}（仍有 ${result.batchesRemaining} 批未完成，可稍后再次手动整合续跑）`,
    };
  }
  return result;
}

function failJob(trigger: DreamJobTrigger, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  finishJob(trigger, {
    lastExecuted: false,
    lastSummary: `Dream failed: ${msg}`,
    lastError: msg,
  });
  console.error(`[MemoryDreamRunner] ${trigger} dream failed:`, error);
}

/**
 * 串行入队后台任务；若已有任务运行中则返回 false。
 */
export function enqueueDreamJob(trigger: DreamJobTrigger, work: () => Promise<void>): boolean {
  if (jobStatus.running) return false;

  beginJob(trigger);
  runChain = runChain
    .then(work)
    .catch((err) => {
      if (jobStatus.running) failJob(trigger, err);
    });

  return true;
}

/** 执行一次手动 Dream（由 runChain 串行调度） */
async function runManualDreamLlmJob(params: ManualDreamBackgroundParams): Promise<void> {
  const { memoryDir, llmAdapter, fileCountBefore, preEvicted } = params;
  beginJob('manual');
  const startMs = Date.now();

  const dream = createMemoryDream();
  await dream.loadPersistedState();
  const gate = await dream.evaluateDreamGate(memoryDir);

  try {
    const emptyBackoff = dream.peekDreamEmptyRunBackoff();
    if (!emptyBackoff.ok) {
      const durationMs = Date.now() - startMs;
      const summary = emptyBackoff.reason;

      getScannerCache().invalidate(memoryDir);

      await getMemoryTelemetry().logDream({
        executed: false,
        fileCountBefore,
        filesModified: 0,
        filesDeleted: 0,
        filesEvicted: preEvicted,
        durationMs,
        trigger: 'manual',
        skipReason: emptyBackoff.reason,
      }).catch(() => {});

      finishJob('manual', {
        lastExecuted: false,
        lastSummary: summary,
        filesModified: 0,
        filesDeleted: 0,
        filesEvicted: preEvicted,
        durationMs,
      });

      console.log(
        `[MemoryDreamRunner] manual dream skipped: ${summary} (${durationMs}ms)`,
      );
      return;
    }

    const result: DreamResult = await runDreamWithBatchContinuations(() =>
      dream.forceDream(memoryDir, llmAdapter),
    );
    const totalEvicted = preEvicted + (result.filesEvicted ?? 0);

    if (result.executed && gate.trigger === 'stale_index') {
      dream.notifyStaleIndexDreamCompleted();
    } else if (result.executed) {
      dream.notifyDreamSubstantiveRun();
    } else if (!result.executed) {
      dream.notifyDreamEmptyRun();
      await dream.flushPersistedState();
    }

    getScannerCache().invalidate(memoryDir);

    const manualSkipReason = result.executed
      ? undefined
      : (result.skipReason
        ?? (result.summary.includes('No memories to consolidate')
          ? 'no_memories'
          : 'empty_run'));

    await getMemoryTelemetry().logDream({
      executed: result.executed,
      fileCountBefore,
      filesModified: result.filesModified,
      filesDeleted: result.filesDeleted,
      filesEvicted: totalEvicted,
      durationMs: result.duration,
      trigger: 'manual',
      skipReason: manualSkipReason,
    }).catch(() => {});

    const summary =
      preEvicted > 0
        ? `${result.summary}${result.summary.endsWith('.') ? '' : '。'} LLM 前已归档 ${preEvicted} 条。`
        : result.summary;

    finishJob('manual', {
      lastExecuted: result.executed,
      lastSummary: summary,
      filesModified: result.filesModified,
      filesDeleted: result.filesDeleted,
      filesEvicted: totalEvicted,
      durationMs: result.duration,
    });

    console.log(
      `[MemoryDreamRunner] manual dream ${result.executed ? 'done' : 'skipped'}: ${summary} (${result.duration}ms)`,
    );
  } catch (err) {
    await getMemoryTelemetry().logDream({
      executed: false,
      fileCountBefore,
      filesModified: 0,
      filesDeleted: 0,
      filesEvicted: preEvicted,
      durationMs: Date.now() - startMs,
      trigger: 'manual',
    }).catch(() => {});
    failJob('manual', err);
    throw err;
  }
}

/**
 * 手动整合：LLM 阶段放后台（规则修复与归档应在调用前同步完成）。
 * 连续 POST 会串行入队（不返回 409），便于 Turn 7 验收 POST ×2。
 */
export function scheduleManualDreamLlm(params: ManualDreamBackgroundParams): boolean {
  runChain = runChain
    .then(() => runManualDreamLlmJob(params))
    .catch((err) => {
      console.error('[MemoryDreamRunner] manual dream chain error:', err);
    });
  return true;
}

/** autoDream：门控通过后 LLM 整合放后台 */
export function scheduleAutoDream(params: AutoDreamBackgroundParams): boolean {
  const {
    memoryDir,
    llmAdapter,
    conversationPrefix,
    dreamGateTrigger,
    fileCountBefore,
    onAfterDream,
  } = params;

  return enqueueDreamJob('auto', async () => {
    const dream = createMemoryDream();
    const startMs = Date.now();

    try {
      const prefix =
        conversationPrefix && conversationPrefix.length > 0 ? conversationPrefix : undefined;
      const result = await runDreamWithBatchContinuations(() =>
        dream.dream(memoryDir, llmAdapter, prefix),
      );

      getScannerCache().invalidate(memoryDir);

      if (result.executed && dreamGateTrigger === 'stale_index') {
        dream.notifyStaleIndexDreamCompleted();
      } else if (result.executed) {
        dream.notifyDreamSubstantiveRun();
      } else if (!result.executed) {
        dream.notifyDreamEmptyRun();
        await dream.flushPersistedState();
      }

      await getMemoryTelemetry().logDream({
        executed: result.executed,
        fileCountBefore,
        filesModified: result.filesModified,
        filesDeleted: result.filesDeleted,
        filesEvicted: result.filesEvicted,
        durationMs: result.duration,
        trigger: dreamGateTrigger ?? 'session_interval',
        skipReason: result.executed ? undefined : (result.skipReason ?? 'empty_run'),
      }).catch(() => {});

      if (result.executed) {
        console.log(
          `[MemoryDreamRunner] autoDream: ${result.summary} ` +
          `(${result.filesModified} 修改, ${result.filesDeleted} 删除` +
          `${result.filesEvicted ? `, ${result.filesEvicted} 淘汰归档` : ''}) ` +
          `${result.duration}ms)`,
        );
      }

      await onAfterDream?.();

      finishJob('auto', {
        lastExecuted: result.executed,
        lastSummary: result.summary,
        filesModified: result.filesModified,
        filesDeleted: result.filesDeleted,
        filesEvicted: result.filesEvicted ?? 0,
        durationMs: result.duration,
      });
    } catch (err) {
      await getMemoryTelemetry().logDream({
        executed: false,
        fileCountBefore,
        filesModified: 0,
        filesDeleted: 0,
        durationMs: Date.now() - startMs,
        trigger: dreamGateTrigger ?? 'session_interval',
      }).catch(() => {});
      throw err;
    }
  });
}

/** 测试用：重置运行状态 */
export function resetDreamJobStateForTests(): void {
  jobStatus = idleStatus();
  runChain = Promise.resolve();
}
