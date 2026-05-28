#!/usr/bin/env tsx
/**
 * Eval Runner CLI — TaskGraph 评估工具。
 *
 * 用法：
 *   npx tsx scripts/eval-runner.ts --replay <graphId>
 *   npx tsx scripts/eval-runner.ts --benchmark <name>
 *   npx tsx scripts/eval-runner.ts --all --format json
 *   npx tsx scripts/eval-runner.ts --help
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  calcNodeScore,
  calcBranchEfficiency,
  calcSuccessConfidence,
  buildGraphMetrics,
  ReplayBuilder,
} from '../src/harness/task-graph-metrics.js';
import type { NodeMetrics, BranchMetrics } from '../src/types/task-graph.js';

// ═══════════════════════════════════════════════
// CLI Args
// ═══════════════════════════════════════════════

interface CliArgs {
  help: boolean;
  benchmark?: string;
  all: boolean;
  replay?: string;
  format: 'markdown' | 'json';
  output?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { help: false, all: false, format: 'markdown' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--benchmark':
        result.benchmark = args[++i];
        break;
      case '--all':
        result.all = true;
        break;
      case '--replay':
        result.replay = args[++i];
        break;
      case '--format':
        result.format = args[++i] as 'markdown' | 'json';
        break;
      case '--output':
        result.output = args[++i];
        break;
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`Eval Runner — TaskGraph 评估工具

用法:
  npx tsx scripts/eval-runner.ts [options]

Options:
  --benchmark <name>  加载并运行指定的 benchmark
  --all               运行所有 benchmark
  --replay <graphId>  从 checkpoint 回放指定 graph
  --format <fmt>      输出格式: markdown | json (默认: markdown)
  --output <path>     输出文件路径 (默认: stdout)
  --help, -h          显示帮助
`);
}

// ═══════════════════════════════════════════════
// Benchmarks
// ═══════════════════════════════════════════════

interface BenchmarkCase {
  name: string;
  goal: string;
  intent: string;
  nodeMetrics: NodeMetrics[];
  branchMetrics: BranchMetrics[];
  totalRounds: number;
  totalToolCalls: number;
  totalDuration: number;
}

function loadBenchmark(name: string): BenchmarkCase | null {
  // Simple built-in benchmarks
  const benchmarks: Record<string, BenchmarkCase> = {
    smoke: {
      name: 'smoke',
      goal: '修复登录bug',
      intent: 'edit',
      nodeMetrics: [
        { nodeId: 'n1', nodeType: 'inspect', roundsUsed: 2, toolCalls: 4, retries: 0, success: true, signalCompletionRate: 1, idleRounds: 0 },
        { nodeId: 'n2', nodeType: 'edit', roundsUsed: 3, toolCalls: 6, retries: 1, success: true, signalCompletionRate: 0.8, idleRounds: 1 },
        { nodeId: 'n3', nodeType: 'verify', roundsUsed: 1, toolCalls: 2, retries: 0, success: true, signalCompletionRate: 1, idleRounds: 0 },
      ],
      branchMetrics: [
        { branchId: 'b1', isFallback: false, nodeCount: 3, fallbackRate: 0, branchEfficiency: 100, recoveryCost: 0, branchDeadRatio: 0, avgNodeScore: 85, totalDuration: 15000 },
      ],
      totalRounds: 6, totalToolCalls: 12, totalDuration: 15000,
    },
    fallback: {
      name: 'fallback',
      goal: '重构支付模块',
      intent: 'refactor',
      nodeMetrics: [
        { nodeId: 'n1', nodeType: 'inspect', roundsUsed: 2, toolCalls: 4, retries: 0, success: true, signalCompletionRate: 1, idleRounds: 0 },
        { nodeId: 'n2', nodeType: 'edit', roundsUsed: 5, toolCalls: 10, retries: 3, success: false, signalCompletionRate: 0.4, idleRounds: 2, failureReason: 'max retries' },
        { nodeId: 'fb1', nodeType: 'fallback', roundsUsed: 4, toolCalls: 8, retries: 1, success: true, signalCompletionRate: 0.6, idleRounds: 1 },
      ],
      branchMetrics: [
        { branchId: 'b1', isFallback: false, nodeCount: 2, fallbackRate: 0, branchEfficiency: 50, recoveryCost: 0, branchDeadRatio: 0, avgNodeScore: 40, totalDuration: 8000 },
        { branchId: 'b2', isFallback: true, nodeCount: 1, fallbackRate: 1, branchEfficiency: 80, recoveryCost: 5, branchDeadRatio: 0, avgNodeScore: 70, totalDuration: 5000 },
      ],
      totalRounds: 11, totalToolCalls: 22, totalDuration: 13000,
    },
  };

  return benchmarks[name] ?? null;
}

function listBenchmarks(): string[] {
  return ['smoke', 'fallback'];
}

// ═══════════════════════════════════════════════
// Eval Output
// ═══════════════════════════════════════════════

interface EvalOutput {
  caseName: string;
  goal: string;
  completionScore: number;
  successConfidence: number;
  nodeScores: Array<{ nodeId: string; score: number }>;
  wastedSteps: number;
}

function runCase(bm: BenchmarkCase): EvalOutput {
  const graphMetrics = buildGraphMetrics({
    graphId: `eval-${bm.name}`,
    goal: bm.goal,
    intent: bm.intent,
    nodeMetrics: bm.nodeMetrics,
    branchMetrics: bm.branchMetrics,
    totalRounds: bm.totalRounds,
    totalToolCalls: bm.totalToolCalls,
    totalDuration: bm.totalDuration,
  });

  return {
    caseName: bm.name,
    goal: bm.goal,
    completionScore: graphMetrics.completionScore,
    successConfidence: graphMetrics.successConfidence,
    nodeScores: bm.nodeMetrics.map(n => ({
      nodeId: n.nodeId,
      score: calcNodeScore(n),
    })),
    wastedSteps: graphMetrics.wastedSteps,
  };
}

function runReplay(graphId: string): EvalOutput {
  return {
    caseName: `replay-${graphId}`,
    goal: graphId,
    completionScore: 0,
    successConfidence: 0,
    nodeScores: [],
    wastedSteps: 0,
  };
}

// ═══════════════════════════════════════════════
// Report Generation
// ═══════════════════════════════════════════════

function generateReport(results: EvalOutput[], format: 'markdown' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(results, null, 2);
  }

  let md = '# Eval Report\n\n';
  for (const r of results) {
    md += `## ${r.caseName}\n\n`;
    md += `- **目标**: ${r.goal}\n`;
    md += `- **完成评分**: ${r.completionScore}/100\n`;
    md += `- **成功置信度**: ${r.successConfidence}\n`;
    md += `- **浪费步骤**: ${r.wastedSteps}\n`;
    if (r.nodeScores.length > 0) {
      md += `- **节点评分**:\n`;
      for (const ns of r.nodeScores) {
        md += `  - ${ns.nodeId}: ${ns.score}/100\n`;
      }
    }
    md += '\n';
  }

  return md;
}

// ═══════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════

function main(): void {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  const results: EvalOutput[] = [];

  if (args.replay) {
    results.push(runReplay(args.replay));
  }

  if (args.all) {
    for (const name of listBenchmarks()) {
      const bm = loadBenchmark(name);
      if (bm) results.push(runCase(bm));
    }
  }

  if (args.benchmark) {
    const bm = loadBenchmark(args.benchmark);
    if (!bm) {
      console.error(`Unknown benchmark: ${args.benchmark}`);
      console.error(`Available: ${listBenchmarks().join(', ')}`);
      process.exit(1);
    }
    results.push(runCase(bm));
  }

  if (results.length === 0) {
    console.error('No action specified. Use --help for usage.');
    process.exit(1);
  }

  const report = generateReport(results, args.format);

  if (args.output) {
    mkdirSync(path.dirname(args.output), { recursive: true });
    writeFileSync(args.output, report, 'utf-8');
    console.log(`Report written to ${args.output}`);
  } else {
    console.log(report);
  }
}

main();
