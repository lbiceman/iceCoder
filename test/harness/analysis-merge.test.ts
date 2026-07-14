import { describe, expect, it } from 'vitest';

import { mergeAnalysisArtifacts } from '../../src/harness/analysis-merge.js';
import type { ReadyAnalysisSummary } from '../../src/harness/supervisor/analysis-supervisor.js';
import { ASYNC_SUB_AGENT_SCHEMA_VERSION } from '../../src/types/async-sub-agent.js';

function ready(taskId: string, kind: ReadyAnalysisSummary['kind'], summaryPreview: string): ReadyAnalysisSummary {
  return {
    event: 'analysis_ready',
    sessionId: 'sess',
    taskId,
    kind,
    artifactPath: `analysis/${taskId}.md`,
    summaryPreview,
    filesRead: [`src/${taskId}.ts`],
    createdAt: 1,
    artifact: {
      version: ASYNC_SUB_AGENT_SCHEMA_VERSION,
      id: taskId,
      sessionId: 'sess',
      taskId,
      kind,
      relativePath: `analysis/${taskId}.md`,
      summary: summaryPreview,
      filesRead: [`src/${taskId}.ts`],
      status: 'completed',
      createdAt: 1,
    },
  };
}

describe('analysis-merge', () => {
  it('merges multiple ready analyses into one injection block', () => {
    const block = mergeAnalysisArtifacts([
      ready('a', 'explorer', 'Explorer summary'),
      ready('b', 'search', 'Search summary'),
    ]);

    expect(block).toContain('[Analysis Ready]');
    expect(block).toContain('explorer task a');
    expect(block).toContain('search task b');
    expect(block).toContain('src/a.ts');
    expect(block).toContain('src/b.ts');
    expect(block).toContain('Do not call read_file on analysis artifact paths');
    expect(block).toContain('use factual engineering language');
    expect(block).not.toContain('analysis/a.md');
    expect(block).not.toContain('analysis/b.md');
  });
});
