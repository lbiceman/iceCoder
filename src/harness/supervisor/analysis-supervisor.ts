import type {
  AnalysisArtifact,
  AnalysisReadyEvent,
  AnalysisTimelinePayload,
  RequestAnalysisInput,
  RequestAnalysisResult,
  SubAgentKind,
} from '../../types/async-sub-agent.js';
import type {
  EventTimeline,
  SupervisorTimelineEventType,
} from '../../types/supervisor.js';
import type {
  AsyncSubAgentManager,
  AsyncSubAgentManagerEventPayload,
} from '../async-sub-agent-manager.js';
import {
  listAnalysisArtifacts,
  listPendingAnalysisTasks,
  markArtifactConsumed,
} from '../analysis-workspace-store.js';

export interface AnalysisSupervisorOptions {
  /** Session data directory containing `{sessionId}/analysis`. */
  sessionDir: string;
  /** Background async sub-agent lifecycle manager. */
  manager: AsyncSubAgentManager;
  /** Optional supervisor event timeline. */
  eventTimeline?: EventTimeline;
  /** Runtime mode label for timeline records. */
  mode?: string;
}

export interface AnalysisRequestRuntimeContext {
  /** Harness round that produced the request. */
  round?: number;
  /** Runtime mode label; defaults to supervisor option or `free`. */
  mode?: string;
  /** Timeline reason; defaults to `request_analysis`. */
  reason?: string;
}

export interface ReadyAnalysisSummary extends AnalysisReadyEvent {
  artifact: AnalysisArtifact;
}

export class AnalysisSupervisor {
  private readonly sessionDir: string;
  private readonly manager: AsyncSubAgentManager;
  private readonly eventTimeline?: EventTimeline;
  private readonly defaultMode: string;

  constructor(options: AnalysisSupervisorOptions) {
    this.sessionDir = options.sessionDir;
    this.manager = options.manager;
    this.eventTimeline = options.eventTimeline;
    this.defaultMode = options.mode ?? 'free';

    this.manager.on('analysis_started', payload => {
      this.record('analysis_started', payload, 'async_sub_agent_started');
    });
    this.manager.on('analysis_finished', payload => {
      this.record('analysis_finished', payload, 'async_sub_agent_finished');
      if (payload.artifact) {
        this.record('workspace_analysis_updated', payload, 'analysis_artifact_written');
        this.record('analysis_ready', payload, 'analysis_ready');
      }
    });
  }

  requestAnalysis(
    input: RequestAnalysisInput,
    runtime: AnalysisRequestRuntimeContext = {},
  ): RequestAnalysisResult {
    const result = this.manager.submit(input);
    this.record('analysis_requested', {
      sessionId: input.sessionId,
      taskId: result.taskId,
      kind: input.kind,
      status: result.status,
      task: {
        version: 1,
        taskId: result.taskId,
        sessionId: input.sessionId,
        kind: input.kind,
        prompt: input.prompt,
        status: result.status,
        filesRead: [],
        createdAt: input.requestedAt ?? Date.now(),
      },
    }, runtime.reason ?? 'request_analysis', runtime);
    return result;
  }

  requestAnalysisBatch(
    inputs: RequestAnalysisInput[],
    runtime: AnalysisRequestRuntimeContext = {},
  ): RequestAnalysisResult[] {
    return inputs.map(input => this.requestAnalysis(input, runtime));
  }

  async getReadyAnalyses(
    sessionId: string,
    unconsumedOnly = true,
  ): Promise<ReadyAnalysisSummary[]> {
    const artifacts = await listAnalysisArtifacts(this.sessionDir, sessionId);
    return artifacts
      .filter(artifact => !unconsumedOnly || artifact.consumedAt == null)
      .filter(artifact => artifact.status === 'completed' || artifact.status === 'timeout' || artifact.status === 'failed')
      .map(artifact => ({
        event: 'analysis_ready',
        sessionId,
        taskId: artifact.taskId,
        kind: artifact.kind,
        artifactPath: artifact.relativePath,
        summaryPreview: buildSummaryPreview(artifact.summary),
        filesRead: artifact.filesRead,
        createdAt: artifact.createdAt,
        artifact,
      }));
  }

  async markAnalysisConsumed(
    sessionId: string,
    taskId: string,
    consumedAt: number = Date.now(),
  ): Promise<AnalysisArtifact | null> {
    return markArtifactConsumed(this.sessionDir, sessionId, taskId, consumedAt);
  }

  async hasPendingAnalyses(sessionId: string): Promise<boolean> {
    const pending = await listPendingAnalysisTasks(this.sessionDir, sessionId);
    return pending.length > 0;
  }

  shouldAutoTrigger(kind: SubAgentKind, context?: Record<string, unknown>): boolean {
    const alreadyTriggered = context?.alreadyTriggered === true;
    if (alreadyTriggered) return false;
    return kind === 'explorer'
      || kind === 'search'
      || kind === 'dependency'
      || kind === 'review'
      || kind === 'test_analysis';
  }
  private record(
    event: SupervisorTimelineEventType,
    payload: AsyncSubAgentManagerEventPayload | AnalysisTimelinePayload,
    reason: string,
    runtime: AnalysisRequestRuntimeContext = {},
  ): void {
    this.eventTimeline?.record({
      event,
      round: runtime.round ?? 0,
      mode: runtime.mode ?? this.defaultMode,
      reason,
      payload: {
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        kind: payload.kind,
        status: payload.status,
        artifactPath: payload.artifactPath,
        filesRead: payload.filesRead,
        error: payload.error,
      },
    });
  }
}

function buildSummaryPreview(summary: string): string {
  const compact = summary.replace(/\s+/g, ' ').trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}
