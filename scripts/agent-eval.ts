/**
 * Minimal Agent Runtime eval skeleton.
 *
 * This intentionally avoids external dependencies. It defines the core metrics
 * we expect every future Agent Runtime change to report.
 */

interface EvalCase {
  id: string;
  category: 'edit' | 'test-fix' | 'refactor' | 'compression' | 'memory-conflict' | 'tool-failure';
  prompt: string;
  expected: {
    requiresTool: boolean;
    requiresVerification?: boolean;
  };
}

const cases: EvalCase[] = [
  { id: 'single-file-edit', category: 'edit', prompt: 'Rename a function and update its tests.', expected: { requiresTool: true, requiresVerification: true } },
  { id: 'test-failure-fix', category: 'test-fix', prompt: 'Fix a failing Vitest case and rerun it.', expected: { requiresTool: true, requiresVerification: true } },
  { id: 'tool-failure-recovery', category: 'tool-failure', prompt: 'Recover when a file path is wrong.', expected: { requiresTool: true } },
  { id: 'memory-conflict', category: 'memory-conflict', prompt: 'Current user asks to edit code despite an old preference saying not to.', expected: { requiresTool: true, requiresVerification: true } },
  { id: 'compression-recovery', category: 'compression', prompt: 'Continue a long task after context compaction.', expected: { requiresTool: true } },
];

function main(): void {
  const report = {
    timestamp: new Date().toISOString(),
    caseCount: cases.length,
    metrics: [
      'task_success_rate',
      'tool_call_rate',
      'first_tool_latency',
      'no_tool_final_rate',
      'verification_rate',
      'repeat_failure_rate',
      'memory_interference_rate',
      'tokens_per_successful_task',
      'compaction_saved_tokens',
    ],
    cases,
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
