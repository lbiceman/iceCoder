/**
 * chat-ws 运行中回合快照：F5 / 扫码后还原 ETL / 冰豆 / 工具时间线。
 */

import { extractDiffSource } from './tool-display-extract.js';
import {
  capToolTraceDiffSource,
  persistToolTraceDiff,
} from './session-tool-trace-diffs.js';
import {
  formatToolArgsDetailPreview,
  resolveToolCallInitialStatus,
  resolveToolTraceResultStatus,
} from './tool-trace-format.js';
import { registerSessionRuntimeBusyProbe } from './session-runtime-busy.js';
import {
  SESSIONS_DIR,
  hasActiveSessionRun,
  isSessionProcessing,
  isSessionTombstoned,
  sessionActiveBatchCounts,
} from './chat-ws-runtime.js';

export interface RunningTurnSnapshot {
  isProcessing: boolean;
  runId: number;
  iteration: number;
  streamingText: string;
  /** 当轮思考流（仅 UI，不入库） */
  streamingReasoningText: string;
  toolTimeline: { toolName: string; detail: string; status: string; toolCallId?: string; diffSource?: string | null }[];
  petState: string;
  petBubble: string;
  petStatusText: string;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastEffectiveUsed: number;
  contextWindow: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startedAt: number;
  /** 重放的执行计划 / 任务图 / 执行模式相关 step 事件，前端按现有 bridge 喂回即可重建 UI */
  planEvents: Array<{ type: string; [k: string]: unknown }>;
}

const runningTurns = new Map<string, RunningTurnSnapshot>();
let nextRunningTurnId = 1;

registerSessionRuntimeBusyProbe({
  getRunningTurn: (sessionId) => runningTurns.get(sessionId) ?? null,
  getPendingBatchCount: (sessionId) => sessionActiveBatchCounts.get(sessionId) ?? 0,
});

function createEmptyRunningTurn(): RunningTurnSnapshot {
  return {
    isProcessing: true,
    runId: nextRunningTurnId++,
    iteration: 0,
    streamingText: '',
    streamingReasoningText: '',
    toolTimeline: [],
    petState: 'thinking',
    petBubble: '',
    petStatusText: '',
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastEffectiveUsed: 0,
    contextWindow: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    startedAt: Date.now(),
    planEvents: [],
  };
}

export function getRunningTurn(sessionId: string): RunningTurnSnapshot | undefined {
  return runningTurns.get(sessionId);
}

export function hasRunningTurn(sessionId: string): boolean {
  return runningTurns.has(sessionId);
}

export function ensureRunningTurn(sessionId: string): RunningTurnSnapshot {
  let t = runningTurns.get(sessionId);
  if (!t) {
    t = createEmptyRunningTurn();
    runningTurns.set(sessionId, t);
  }
  return t;
}

export function snapshotRunningTurn(sessionId: string): RunningTurnSnapshot | null {
  const t = runningTurns.get(sessionId);
  if (!t) return null;
  return {
    ...t,
    toolTimeline: t.toolTimeline.map((row) => ({ ...row })),
    planEvents: t.planEvents.map((ev) => ({ ...ev })),
  };
}

export function clearRunningTurn(sessionId: string): void {
  runningTurns.delete(sessionId);
}

/** 正在执行任务的会话 id 列表（供 bootstrap 优先选中「最近工作」会话）。 */
export function getProcessingSessionIds(): string[] {
  const ids: string[] = [];
  for (const [sid, snap] of runningTurns) {
    if (snap.isProcessing) ids.push(sid);
  }
  return ids;
}

/**
 * hasBusySessionRun 需要 runningTurns，不能放进 runtime（runtime 禁止 import 其它 chat-ws-*）。
 */
export function hasBusySessionRun(sessionId: string): boolean {
  return isSessionProcessing(sessionId)
    || hasActiveSessionRun(sessionId)
    || runningTurns.has(sessionId);
}

export function toolArgsDetailPreview(toolName: string, toolArgs: Record<string, unknown> | undefined): string {
  return formatToolArgsDetailPreview(toolName, toolArgs);
}

export function toolResultStatusPreview(
  toolName: string,
  toolSuccess: boolean | undefined,
  toolOutcome: string | undefined,
  toolOutput: string | undefined,
): string {
  return resolveToolTraceResultStatus(toolName, toolSuccess, toolOutcome, toolOutput);
}

export function recordPersistedToolTraceDiff(
  sessionId: string,
  toolCallId: string | undefined,
  diffSource: string | null | undefined,
): void {
  if (!toolCallId || !diffSource || isSessionTombstoned(sessionId)) return;
  void persistToolTraceDiff(SESSIONS_DIR, sessionId, toolCallId, diffSource);
}

/** 把一条 step 事件 fold 进运行中快照，便于新订阅者重建 UI */
export function foldStepIntoRunningTurn(sessionId: string, event: any): void {
  const t = ensureRunningTurn(sessionId);
  if (!event || typeof event !== 'object') return;

  if (typeof event.iteration === 'number' && event.iteration > t.iteration) {
    t.iteration = event.iteration;
  }
  if (event.totalTokenUsage) {
    if (typeof event.totalTokenUsage.inputTokens === 'number') {
      t.lastInputTokens = event.totalTokenUsage.inputTokens;
    }
    if (typeof event.totalTokenUsage.outputTokens === 'number') {
      t.lastOutputTokens = event.totalTokenUsage.outputTokens;
    }
    if (typeof event.totalTokenUsage.effectiveUsed === 'number') {
      t.lastEffectiveUsed = event.totalTokenUsage.effectiveUsed;
    }
    if (typeof event.totalTokenUsage.contextWindow === 'number') {
      t.contextWindow = event.totalTokenUsage.contextWindow;
    }
  }

  switch (event.type) {
    case 'stream_delta':
      if (typeof event.delta === 'string') {
        t.streamingText += event.delta;
        t.petState = 'read';
      }
      break;
    case 'reasoning_stream_delta':
      if (typeof event.delta === 'string') {
        t.streamingReasoningText += event.delta;
        t.petState = 'thinking';
      }
      break;
    case 'thinking':
      t.petState = 'thinking';
      if (typeof event.content === 'string') t.petBubble = event.content;
      break;
    case 'tool_call':
      if (event.toolName) {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
        t.toolTimeline.push({
          toolName: String(event.toolName),
          detail: toolArgsDetailPreview(String(event.toolName), event.toolArgs),
          status: resolveToolCallInitialStatus(String(event.toolName), event.toolArgs),
          toolCallId,
          diffSource: extractDiffSource(String(event.toolName), undefined, event.toolArgs as Record<string, unknown> | undefined),
        });
        t.petState = 'working';
      }
      break;
    case 'tool_result':
      if (event.toolName) {
        for (let i = t.toolTimeline.length - 1; i >= 0; i--) {
          const row = t.toolTimeline[i];
          const idMatch = typeof event.toolCallId === 'string' && event.toolCallId && row.toolCallId === event.toolCallId;
          const nameMatch = row.toolName === event.toolName && (row.status === 'pending' || row.status === 'background');
          if (idMatch || (!event.toolCallId && nameMatch)) {
            row.status = toolResultStatusPreview(
              String(event.toolName),
              event.toolSuccess,
              event.toolOutcome,
              event.toolOutput,
            );
            const fromOutput = extractDiffSource(
              String(event.toolName),
              typeof event.toolOutput === 'string' ? event.toolOutput : undefined,
              event.toolArgs as Record<string, unknown> | undefined,
            );
            if (fromOutput) {
              row.diffSource = fromOutput;
              recordPersistedToolTraceDiff(sessionId, row.toolCallId, fromOutput);
            }
            break;
          }
        }
      }
      break;
    case 'tool_progress':
      if (typeof event.content === 'string') {
        t.petBubble = event.content;
        t.petStatusText = event.content;
      }
      t.petState = 'working';
      break;
    case 'execution_plan_init':
    case 'execution_plan_update':
    case 'execution_plan_clear':
    case 'task_graph_init':
    case 'task_graph_node':
    case 'task_graph_update':
    case 'task_graph_branch':
    case 'task_graph_done':
    case 'execution_mode_enter':
    case 'execution_mode_exit':
      t.planEvents.push({ ...event });
      if (t.planEvents.length > 200) {
        t.planEvents.splice(0, t.planEvents.length - 200);
      }
      break;
    case 'final':
      if (event.stopReason === 'user_checkpoint') {
        t.petState = 'crying';
        t.petBubble = '监管已暂停，需要你介入啦';
        t.petStatusText = '监管已暂停，需要你介入啦';
      } else if (event.stopReason === 'model_done') {
        t.petState = 'success';
        t.petBubble = '已完成';
        t.petStatusText = '已完成';
      }
      break;
    default:
      break;
  }
}

export function purgeRunningTurn(sessionId: string): void {
  runningTurns.delete(sessionId);
}

export function clearAllRunningTurns(): void {
  runningTurns.clear();
}
