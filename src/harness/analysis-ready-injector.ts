import type { AnalysisSupervisor } from './supervisor/analysis-supervisor.js';
import { mergeAnalysisArtifacts } from './analysis-merge.js';

export interface InjectAnalysisReadyOptions {
  supervisor?: AnalysisSupervisor;
  sessionId?: string;
}

export async function takeAnalysisReadyForInjection(
  options: InjectAnalysisReadyOptions,
): Promise<string | null> {
  if (!options.supervisor || !options.sessionId) return null;

  const ready = await options.supervisor.getReadyAnalyses(options.sessionId, true);
  if (ready.length === 0) return null;

  const block = mergeAnalysisArtifacts(ready);
  await Promise.all(
    ready.map(item => options.supervisor!.markAnalysisConsumed(item.sessionId, item.taskId)),
  );
  return block || null;
}
