import type { ReadyAnalysisSummary } from './supervisor/analysis-supervisor.js';

export function mergeAnalysisArtifacts(analyses: readonly ReadyAnalysisSummary[]): string {
  if (analyses.length === 0) return '';

  const lines: string[] = [
    '[Analysis Ready]',
    'Background read-only sub-agent analyses are available. Use these summaries as context.',
    'Do not call read_file on analysis artifact paths; they live in the session analysis store, not the repository workspace.',
    'If exact source details are needed, reread only the workspace files listed in filesRead.',
  ];

  for (const analysis of analyses) {
    lines.push(
      '',
      `- ${analysis.kind} task ${analysis.taskId}`,
      `  summary: ${analysis.summaryPreview || '(empty summary)'}`,
    );
    if (analysis.filesRead.length > 0) {
      lines.push(`  filesRead: ${analysis.filesRead.join(', ')}`);
    }
  }

  return lines.join('\n');
}
