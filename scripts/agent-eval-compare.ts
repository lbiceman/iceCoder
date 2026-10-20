/**
 * 对比两份 agent-eval 历史（JSONL，每行一次运行），按用例输出新旧版本差异的 Markdown 报告。
 *
 *   npx tsx scripts/agent-eval-compare.ts --base=base.jsonl --new=new.jsonl --suite=context [--out=report.md]
 *
 * 口径：
 * - 通过 = runner 的判定（expected + assertions + 评判命令全部满足）
 * - token = loopState 累计 input + output（每次模型调用的 provider usage 之和）
 * - 中位数按用例的全部运行计算，失败的运行也计入
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AGENT_EVAL_SUITES } from './agent-eval-cases.js';

export interface HistoryCaseResult {
  id: string;
  passed: boolean;
  failures?: string[];
  stats?: {
    llmCalls?: number;
    toolCalls?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    peakPromptTokens?: number;
    durationMs?: number;
    toolResults?: {
      rereads?: Record<string, number>;
      budgetShrinks?: number;
      budgetOverflows?: number;
    };
  };
}

export interface HistoryRecord {
  timestamp: string;
  mode: string;
  label?: string;
  suite?: string;
  model?: { providerId: string; model: string };
  contextWindow?: number;
  results: HistoryCaseResult[];
}

export interface CaseSummary {
  runs: number;
  passes: number;
  medianTokens: number;
  meanTokens: number;
  medianInput: number;
  medianOutput: number;
  medianPeakPrompt: number;
  medianLlmCalls: number;
  medianToolCalls: number;
  rereads: number;
  budgetShrinks: number;
  failures: string[];
}

export function parseHistory(text: string): HistoryRecord[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as HistoryRecord);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function summarizeCase(results: HistoryCaseResult[]): CaseSummary {
  const stat = (pick: (r: HistoryCaseResult) => number | undefined) =>
    results.map(pick).filter((v): v is number => typeof v === 'number');
  const tokens = stat(r => r.stats?.totalTokens);
  return {
    runs: results.length,
    passes: results.filter(r => r.passed).length,
    medianTokens: median(tokens),
    meanTokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0,
    medianInput: median(stat(r => r.stats?.inputTokens)),
    medianOutput: median(stat(r => r.stats?.outputTokens)),
    medianPeakPrompt: median(stat(r => r.stats?.peakPromptTokens)),
    medianLlmCalls: median(stat(r => r.stats?.llmCalls)),
    medianToolCalls: median(stat(r => r.stats?.toolCalls)),
    rereads: results.reduce((sum, r) => {
      const rr = r.stats?.toolResults?.rereads ?? {};
      return sum + Object.values(rr).reduce((a, b) => a + b, 0);
    }, 0),
    budgetShrinks: results.reduce((sum, r) => sum + (r.stats?.toolResults?.budgetShrinks ?? 0), 0),
    failures: results.filter(r => !r.passed).flatMap(r => (r.failures ?? []).slice(0, 2)),
  };
}

export function collectByCase(records: HistoryRecord[], suite?: string): Map<string, HistoryCaseResult[]> {
  const byCase = new Map<string, HistoryCaseResult[]>();
  for (const record of records) {
    if (suite && record.suite && record.suite !== suite) continue;
    for (const result of record.results) {
      const list = byCase.get(result.id) ?? [];
      list.push(result);
      byCase.set(result.id, list);
    }
  }
  return byCase;
}

function deltaPct(base: number, next: number): string {
  if (!base) return '';
  const pct = ((next - base) / base) * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

function describeModels(records: HistoryRecord[]): string {
  const models = [...new Set(records.map(r => r.model ? `${r.model.providerId} / ${r.model.model}` : 'unknown'))];
  return models.join(', ');
}

export function formatComparison(input: {
  base: HistoryRecord[];
  next: HistoryRecord[];
  suite?: string;
  baseLabel?: string;
  newLabel?: string;
}): string {
  const baseLabel = input.baseLabel ?? 'base';
  const newLabel = input.newLabel ?? 'new';
  const baseByCase = collectByCase(input.base, input.suite);
  const newByCase = collectByCase(input.next, input.suite);
  const groups = input.suite && AGENT_EVAL_SUITES[input.suite]
    ? AGENT_EVAL_SUITES[input.suite]!
    : [{ group: 'all', cases: [...new Set([...baseByCase.keys(), ...newByCase.keys()])] }];

  const baseModels = describeModels(input.base);
  const newModels = describeModels(input.next);
  const lines: string[] = [
    `| | ${baseLabel} | ${newLabel} |`,
    '| --- | --- | --- |',
    `| 模型 | ${baseModels} | ${newModels} |`,
    `| 运行次数（历史记录条数） | ${input.base.length} | ${input.next.length} |`,
    '',
  ];
  if (baseModels !== newModels) {
    lines.push('> 警告：两边模型不一致，token 与通过率不可直接比较。', '');
  }

  lines.push(
    `| 分组 | 用例 | 通过 ${baseLabel} | 通过 ${newLabel} | token 中位 ${baseLabel} | token 中位 ${newLabel} | 变化 | 单次请求峰值 ${baseLabel} | 单次请求峰值 ${newLabel} | LLM 调用 ${baseLabel} | LLM 调用 ${newLabel} | 工具调用 ${baseLabel} | 工具调用 ${newLabel} | 补读 ${newLabel} | 发送前收紧 ${newLabel} |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  const totals = { base: 0, next: 0, basePass: 0, nextPass: 0, baseRuns: 0, nextRuns: 0 };
  const failureNotes: string[] = [];
  for (const group of groups) {
    for (const id of group.cases) {
      const b = summarizeCase(baseByCase.get(id) ?? []);
      const n = summarizeCase(newByCase.get(id) ?? []);
      totals.base += b.medianTokens;
      totals.next += n.medianTokens;
      totals.basePass += b.passes;
      totals.nextPass += n.passes;
      totals.baseRuns += b.runs;
      totals.nextRuns += n.runs;
      lines.push(
        `| ${group.group} | ${id} | ${b.passes}/${b.runs} | ${n.passes}/${n.runs} | ${b.medianTokens} | ${n.medianTokens} | ${deltaPct(b.medianTokens, n.medianTokens)} | ${b.medianPeakPrompt} | ${n.medianPeakPrompt} | ${b.medianLlmCalls} | ${n.medianLlmCalls} | ${b.medianToolCalls} | ${n.medianToolCalls} | ${n.rereads} | ${n.budgetShrinks} |`,
      );
      for (const [label, s] of [[baseLabel, b], [newLabel, n]] as const) {
        for (const failure of s.failures) {
          failureNotes.push(`- ${label} ${id}: ${failure.replace(/\r?\n/g, ' ').slice(0, 240)}`);
        }
      }
    }
  }
  lines.push(
    `| **合计** | | ${totals.basePass}/${totals.baseRuns} | ${totals.nextPass}/${totals.nextRuns} | ${totals.base} | ${totals.next} | ${deltaPct(totals.base, totals.next)} | | | | | | | | |`,
    '',
  );
  if (failureNotes.length > 0) {
    lines.push('失败原因（每次失败取前两条）：', '', ...failureNotes, '');
  }
  return lines.join('\n');
}

function getArg(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.substring(prefix.length);
}

async function main(): Promise<void> {
  const basePath = getArg('--base');
  const newPath = getArg('--new');
  if (!basePath || !newPath) {
    console.error('Usage: tsx scripts/agent-eval-compare.ts --base=<jsonl> --new=<jsonl> [--suite=context] [--out=report.md]');
    process.exitCode = 1;
    return;
  }
  const [base, next] = await Promise.all([
    fs.readFile(path.resolve(basePath), 'utf8').then(parseHistory),
    fs.readFile(path.resolve(newPath), 'utf8').then(parseHistory),
  ]);
  const report = formatComparison({
    base,
    next,
    suite: getArg('--suite'),
    baseLabel: getArg('--base-label'),
    newLabel: getArg('--new-label'),
  });
  const out = getArg('--out');
  if (out) {
    await fs.writeFile(path.resolve(out), report, 'utf8');
  } else {
    console.log(report);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
