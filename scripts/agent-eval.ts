import { promises as fs } from 'node:fs';
import path from 'node:path';

interface EvalCase {
  id: string;
  category: 'edit' | 'test-fix' | 'refactor' | 'compression' | 'memory-conflict' | 'tool-failure' | 'eval-mode';
  prompt: string;
  expected: {
    requiresTool: boolean;
    requiresVerification?: boolean;
  };
}

interface CaseResult {
  id: string;
  category: EvalCase['category'];
  passed: boolean;
  metrics: EvalMetrics;
  failures: string[];
}

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

const cases: EvalCase[] = [
  { id: 'single-file-edit', category: 'edit', prompt: 'Rename a function and update its tests.', expected: { requiresTool: true, requiresVerification: true } },
  { id: 'test-failure-fix', category: 'test-fix', prompt: 'Fix a failing Vitest case and rerun it.', expected: { requiresTool: true, requiresVerification: true } },
  { id: 'multi-file-refactor', category: 'refactor', prompt: 'Refactor a utility used by several modules and update references.', expected: { requiresTool: true, requiresVerification: true } },
  { id: 'tool-failure-recovery', category: 'tool-failure', prompt: 'Recover when a file path is wrong.', expected: { requiresTool: true } },
  { id: 'memory-conflict', category: 'memory-conflict', prompt: 'Current user asks to edit code despite an old preference saying not to.', expected: { requiresTool: true, requiresVerification: true } },
  { id: 'compression-recovery', category: 'compression', prompt: 'Continue a long task after context compaction.', expected: { requiresTool: true } },
  { id: 'eval-mode-tools-disabled', category: 'eval-mode', prompt: 'Ensure disabled tools and eval mode produce consistent behavior.', expected: { requiresTool: false } },
];

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

async function main(): Promise<void> {
  const mode = getArg('--mode') || (process.env.ICE_AGENT_EVAL_MODE ?? 'mock');
  const results = mode === 'real' ? await runRealEval() : runMockEval();
  const metrics = aggregate(results);
  const report = {
    timestamp: new Date().toISOString(),
    mode,
    caseCount: cases.length,
    metrics,
    results,
  };

  console.log(JSON.stringify(report, null, 2));
  await appendHistory(report);

  if (metrics.task_success_rate < 1 || metrics.no_tool_final_rate > 0 || metrics.memory_interference_rate > 0) {
    process.exitCode = 1;
  }
}

function runMockEval(): CaseResult[] {
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
    return evaluateCase(testCase, metrics);
  });
}

async function runRealEval(): Promise<CaseResult[]> {
  const telemetryPath = path.resolve(process.env.ICE_RUNTIME_TELEMETRY ?? 'data/runtime/telemetry.jsonl');
  const lines = await fs.readFile(telemetryPath, 'utf-8').catch(() => '');
  const summaries = lines
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as any)
    .filter(event => event.type === 'summary');

  if (summaries.length === 0) {
    return cases.map(testCase => evaluateCase(testCase, zeroMetrics(), ['No runtime telemetry summaries found for real eval mode.']));
  }

  const latest = summaries.slice(-cases.length);
  return cases.map((testCase, index) => {
    const summary = latest[index] ?? latest.at(-1);
    const metrics: EvalMetrics = {
      task_success_rate: summary?.stopReason === 'model_done' ? 1 : 0,
      tool_call_rate: summary?.toolCalls > 0 ? 1 : 0,
      first_tool_latency: 0,
      no_tool_final_rate: summary?.noToolFinal ? 1 : 0,
      verification_rate: summary?.verificationRate ?? 0,
      repeat_failure_rate: 0,
      memory_interference_rate: 0,
      tokens_per_successful_task: summary?.tokensPerSuccessfulTask ?? 0,
      compaction_saved_tokens: summary?.compactionSavedTokens ?? 0,
    };
    return evaluateCase(testCase, metrics);
  });
}

function evaluateCase(testCase: EvalCase, metrics: EvalMetrics, initialFailures: string[] = []): CaseResult {
  const failures = [...initialFailures];
  if (metrics.task_success_rate < 1) failures.push('task did not succeed');
  if (testCase.expected.requiresTool && metrics.tool_call_rate < 1) failures.push('expected tool use');
  if (testCase.expected.requiresVerification && metrics.verification_rate < 1) failures.push('expected verification');
  if (testCase.category === 'memory-conflict' && metrics.memory_interference_rate > 0) failures.push('memory interference detected');
  return { id: testCase.id, category: testCase.category, passed: failures.length === 0, metrics, failures };
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

async function appendHistory(report: unknown): Promise<void> {
  const historyPath = path.resolve(process.env.ICE_AGENT_EVAL_HISTORY ?? 'data/eval/agent-eval-history.jsonl');
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(report)}\n`, 'utf-8');
}

function getArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (found) return found.substring(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
