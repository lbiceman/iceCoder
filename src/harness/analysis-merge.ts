import type { ReadyAnalysisSummary } from './supervisor/analysis-supervisor.js';

export function mergeAnalysisArtifacts(analyses: readonly ReadyAnalysisSummary[]): string {
  if (analyses.length === 0) return '';

  const lines: string[] = [
    '[Analysis Ready]',
    'Background read-only sub-agent analyses are available. Use these summaries as context; reread files if a code change depends on exact details.',
  ];

  for (const analysis of analyses) {
    lines.push(
      '',
      `- ${analysis.kind} task ${analysis.taskId}`,
      `  artifact: ${analysis.artifactPath}`,
      `  summary: ${analysis.summaryPreview || '(empty summary)'}`,
    );
    if (analysis.filesRead.length > 0) {
      lines.push(`  filesRead: ${analysis.filesRead.join(', ')}`);
    }
  }

  return lines.join('\n');
}
