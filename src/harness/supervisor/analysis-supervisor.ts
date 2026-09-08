import type {
  AnalysisArtifact,
  AnalysisReadyEvent,
  RequestAnalysisInput,
  RequestAnalysisResult,
  SubAgentKind,
} from '../../types/async-sub-agent.js';
import type {
  AsyncSubAgentManager,
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
}

export interface ReadyAnalysisSummary extends AnalysisReadyEvent {
  artifact: AnalysisArtifact;
}

export class AnalysisSupervisor {
  private readonly sessionDir: string;
  private readonly manager: AsyncSubAgentManager;
  constructor(options: AnalysisSupervisorOptions) {
    this.sessionDir = options.sessionDir;
    this.manager = options.manager;
  }

  requestAnalysis(input: RequestAnalysisInput): RequestAnalysisResult {
    return this.manager.submit(input);
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
}

function buildSummaryPreview(summary: string): string {
  const compact = summary.replace(/\s+/g, ' ').trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}
