import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runSessionFlowEval,
  type SessionFlowEvalReport,
} from './session-flow-eval-runner.js';

async function main(): Promise<void> {
  const format = getArg('--format') === 'markdown' ? 'markdown' : 'json';
  const keepWorkspace = process.argv.includes('--keep-workspace');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-session-flow-eval-'));
  try {
    const report = await runSessionFlowEval({ workspaceRoot: workspace });
    console.log(format === 'markdown' ? formatMarkdown(report) : JSON.stringify(report, null, 2));
    await appendHistory(report);
    if (report.passRate < 1) process.exitCode = 1;
  } finally {
    if (keepWorkspace) {
      console.error(`[session-flow-eval] workspace: ${workspace}`);
    } else {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}

function formatMarkdown(report: SessionFlowEvalReport): string {
  const lines = [
    '# Session Flow Eval Report',
    '',
    `- timestamp: ${report.timestamp}`,
    `- mode: ${report.mode}`,
    `- cases: ${report.caseCount}`,
    `- passed: ${report.passedCount}`,
    `- pass_rate: ${report.passRate}`,
    '',
  ];
  for (const result of report.results) {
    lines.push(`## ${result.passed ? 'PASS' : 'FAIL'} ${result.id}`);
    lines.push('');
    lines.push(`- category: ${result.category}`);
    lines.push(`- duration_ms: ${result.durationMs}`);
    for (const failure of result.failures) lines.push(`- failure: ${failure}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function appendHistory(report: SessionFlowEvalReport): Promise<void> {
  const historyPath = path.resolve(
    process.env.ICE_SESSION_FLOW_EVAL_HISTORY ?? 'data/eval/session-flow-eval-history.jsonl',
  );
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(report)}\n`, 'utf-8');
}

function getArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
