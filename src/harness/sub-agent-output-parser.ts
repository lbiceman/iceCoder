import type {
  DependencyOutput,
  ExplorerOutput,
  ReviewOutput,
  SearchOutput,
  SubAgentKind,
  SubAgentOutput,
  TestAnalysisOutput,
} from '../types/async-sub-agent.js';

function sectionItems(markdown: string, heading: string): string[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)#{1,3}\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s+|$)`, 'i').exec(markdown);
  if (!match?.[1]) return [];
  return match[1]
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(line => line.length > 0 && line !== '(none inspected)' && line !== '(none)');
}

export function parseSubAgentOutput(kind: SubAgentKind, markdown: string): SubAgentOutput {
  switch (kind) {
    case 'explorer': {
      const data: ExplorerOutput = {
        modules: sectionItems(markdown, 'Modules'),
        directories: sectionItems(markdown, 'Directories'),
        entrypoints: sectionItems(markdown, 'Entrypoints'),
        dependencies: sectionItems(markdown, 'Dependencies'),
        callRelations: sectionItems(markdown, 'Call Relations'),
      };
      return { kind, data };
    }
    case 'search': {
      const data: SearchOutput = {
        files: sectionItems(markdown, 'Files'),
        functions: sectionItems(markdown, 'Functions'),
        references: sectionItems(markdown, 'References'),
        keywords: sectionItems(markdown, 'Keywords'),
      };
      return { kind, data };
    }
    case 'review': {
      const data: ReviewOutput = {
        risks: sectionItems(markdown, 'Risks'),
        suggestions: sectionItems(markdown, 'Suggestions'),
        possibleImpacts: sectionItems(markdown, 'Possible Impacts'),
      };
      return { kind, data };
    }
    case 'dependency': {
      const data: DependencyOutput = {
        imports: sectionItems(markdown, 'Imports'),
        callChains: sectionItems(markdown, 'Call Chains'),
        circularDependencies: sectionItems(markdown, 'Circular Dependencies'),
      };
      return { kind, data };
    }
    case 'test_analysis': {
      const data: TestAnalysisOutput = {
        coverage: sectionItems(markdown, 'Coverage'),
        failureReasons: sectionItems(markdown, 'Failure Reasons'),
        testEntrypoints: sectionItems(markdown, 'Test Entrypoints'),
      };
      return { kind, data };
    }
  }
}
