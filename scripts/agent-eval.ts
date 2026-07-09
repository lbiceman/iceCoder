import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChatFunction } from '../src/harness/types.js';
import { agentEvalCases, type AgentEvalCase } from './agent-eval-cases.js';

interface EvalMetrics {
  task_success_rate: number;
  tool_call_rate: number;
  first_tool_latency: number;
  no_tool_final_rate: number;
  verification_rate: number;
  repeat_failure_rate: number;
  memory_interference_rate: number;
  tokens_per_successful_task: number;
  compaction_saved_tokens: number;
}

interface CaseResult {
  id: string;
  category: AgentEvalCase['category'];
  passed: boolean;
  metrics: EvalMetrics;
  failures: string[];
  workspace?: string;
}

const METRIC_KEYS: Array<keyof EvalMetrics> = [
  'task_success_rate',
  'tool_call_rate',
  'first_tool_latency',
  'no_tool_final_rate',
  'verification_rate',
  'repeat_failure_rate',
  'memory_interference_rate',
  'tokens_per_successful_task',
  'compaction_saved_tokens',
];

interface CliArgs {
  mode: 'real' | 'mock';
  caseId?: string;
  format: 'json' | 'markdown';
  keepWorkspaces: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  const selectedCases = selectCases(args.caseId);
  const results = args.mode === 'real'
    ? await runRealEval(selectedCases, args)
    : runMockEval(selectedCases);
  const metrics = aggregate(results);
  const report = {
    timestamp: new Date().toISOString(),
    mode: args.mode,
    caseCount: selectedCases.length,
    metrics,
    results,
  };

  console.log(formatReport(report, args.format));
  await appendHistory(report);

  if (results.some(result => !result.passed)
    || metrics.task_success_rate < 1
    || metrics.no_tool_final_rate > 0
    || metrics.memory_interference_rate > 0) {
    process.exitCode = 1;
  }
}

function runMockEval(cases: AgentEvalCase[]): CaseResult[] {
  return cases.map((testCase, index) => {
    const metrics: EvalMetrics = {
      task_success_rate: 1,
      tool_call_rate: testCase.expected.requiresTool ? 1 : 0,
      first_tool_latency: testCase.expected.requiresTool ? 1 + index : 0,
      no_tool_final_rate: testCase.expected.requiresTool ? 0 : 0,
      verification_rate: testCase.expected.requiresVerification ? 1 : 0,
      repeat_failure_rate: testCase.category === 'tool-failure' ? 0 : 0,
      memory_interference_rate: testCase.category === 'memory-conflict' ? 0 : 0,
      tokens_per_successful_task: 1000 + index * 100,
      compaction_saved_tokens: testCase.category === 'compression' ? 5000 : 0,
    };
    return { id: testCase.id, category: testCase.category, passed: true, metrics, failures: [] };
  });
}

async function runRealEval(cases: AgentEvalCase[], args: CliArgs): Promise<CaseResult[]> {
  await ensureWebStreamsGlobals();
  const { runAgentEvalCase } = await import('./agent-eval-runner.js');
  const chatFn = await createRealChatFunction();
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    console.error(`[agent-eval] running ${testCase.id}`);
    results.push(await runAgentEvalCase(testCase, {
      chatFn,
      keepWorkspace: args.keepWorkspaces,
    }));
  }
  return results;
}

function aggregate(results: CaseResult[]): EvalMetrics {
  const aggregateMetrics = zeroMetrics();
  for (const key of METRIC_KEYS) {
    aggregateMetrics[key] = average(results.map(result => result.metrics[key]));
  }
  return aggregateMetrics;
}

function zeroMetrics(): EvalMetrics {
  return {
    task_success_rate: 0,
    tool_call_rate: 0,
    first_tool_latency: 0,
    no_tool_final_rate: 0,
    verification_rate: 0,
    repeat_failure_rate: 0,
    memory_interference_rate: 0,
    tokens_per_successful_task: 0,
    compaction_saved_tokens: 0,
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function ensureWebStreamsGlobals(): Promise<void> {
  if (typeof globalThis.ReadableStream !== 'undefined'
    && typeof globalThis.WritableStream !== 'undefined'
    && typeof globalThis.TransformStream !== 'undefined') {
    return;
  }
  const webStreams = await import('node:stream/web');
  globalThis.ReadableStream ??= webStreams.ReadableStream as typeof globalThis.ReadableStream;
  globalThis.WritableStream ??= webStreams.WritableStream as typeof globalThis.WritableStream;
  globalThis.TransformStream ??= webStreams.TransformStream as typeof globalThis.TransformStream;
}

async function createRealChatFunction(): Promise<ChatFunction> {
  const [{ resolveDataPaths, ensureDataDir }, { loadConfig, initializeLLMAdapter }] = await Promise.all([
    import('../src/cli/paths.js'),
    import('../src/cli/bootstrap.js'),
  ]);
  const paths = await resolveDataPaths();
  await ensureDataDir(paths);
  const providers = await loadConfig(paths.configPath);
  if (providers.length === 0) {
    throw new Error('No LLM provider configured. Use --mode=mock for a no-API smoke run.');
  }
  const llmAdapter = initializeLLMAdapter(providers);
  return (messages, options) => llmAdapter.chat(messages, {
    ...options,
    requestTimeoutMs: Number(process.env.ICE_AGENT_EVAL_REQUEST_TIMEOUT_MS ?? 120_000),
  });
}

async function appendHistory(report: unknown): Promise<void> {
  const historyPath = path.resolve(process.env.ICE_AGENT_EVAL_HISTORY ?? 'data/eval/agent-eval-history.jsonl');
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(report)}\n`, 'utf-8');
}

function selectCases(caseId: string | undefined): AgentEvalCase[] {
  if (!caseId) return agentEvalCases;
  const selected = agentEvalCases.filter(testCase => testCase.id === caseId);
  if (selected.length === 0) {
    throw new Error(`Unknown eval case: ${caseId}. Available: ${agentEvalCases.map(testCase => testCase.id).join(', ')}`);
  }
  return selected;
}

function formatReport(report: {
  timestamp: string;
  mode: string;
  caseCount: number;
  metrics: EvalMetrics;
  results: CaseResult[];
}, format: 'json' | 'markdown'): string {
  if (format === 'json') return JSON.stringify(report, null, 2);

  const lines: string[] = [
    '# Agent Eval Report',
    '',
    `- timestamp: ${report.timestamp}`,
    `- mode: ${report.mode}`,
    `- cases: ${report.caseCount}`,
    `- task_success_rate: ${roundMetric(report.metrics.task_success_rate)}`,
    `- verification_rate: ${roundMetric(report.metrics.verification_rate)}`,
    `- no_tool_final_rate: ${roundMetric(report.metrics.no_tool_final_rate)}`,
    `- memory_interference_rate: ${roundMetric(report.metrics.memory_interference_rate)}`,
    '',
  ];

  for (const result of report.results) {
    lines.push(`## ${result.passed ? 'PASS' : 'FAIL'} ${result.id}`);
    lines.push('');
    lines.push(`- category: ${result.category}`);
    lines.push(`- tool_call_rate: ${roundMetric(result.metrics.tool_call_rate)}`);
    lines.push(`- verification_rate: ${roundMetric(result.metrics.verification_rate)}`);
    lines.push(`- tokens_per_successful_task: ${roundMetric(result.metrics.tokens_per_successful_task)}`);
    if (result.workspace) lines.push(`- workspace: ${result.workspace}`);
    if (result.failures.length > 0) {
      lines.push('- failures:');
      for (const failure of result.failures) {
        lines.push(`  - ${failure.replace(/\r?\n/g, ' ')}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(): CliArgs {
  const envMode = process.env.ICE_AGENT_EVAL_MODE === 'mock' ? 'mock' : 'real';
  const modeArg = getArg('--mode') ?? envMode;
  if (modeArg !== 'real' && modeArg !== 'mock') {
    throw new Error(`Invalid --mode: ${modeArg}. Expected "real" or "mock".`);
  }
  const formatArg = getArg('--format') ?? 'json';
  if (formatArg !== 'json' && formatArg !== 'markdown') {
    throw new Error(`Invalid --format: ${formatArg}. Expected "json" or "markdown".`);
  }
  return {
    mode: modeArg,
    caseId: getArg('--case'),
    format: formatArg,
    keepWorkspaces: hasFlag('--keep-workspaces'),
    help: hasFlag('--help') || hasFlag('-h'),
  };
}

function printHelp(): void {
  console.log(`Agent Eval Runner

Usage:
  npm run eval:agent
  npm run eval:agent -- --mode=mock
  npm run eval:agent -- --case=single-file-edit --format=markdown

Options:
  --mode=<real|mock>       real drives Harness with configured LLM; mock is no-API smoke
  --case=<id>              run one case
  --format=<json|markdown> output format
  --keep-workspaces        keep temp workspaces for debugging
  --help, -h               show help
`);
}

function getArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (found) return found.substring(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
