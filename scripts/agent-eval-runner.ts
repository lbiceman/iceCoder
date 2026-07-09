import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileParser } from '../src/parser/file-parser.js';
import { HtmlParserStrategy } from '../src/parser/html-strategy.js';
import { OfficeParserStrategy } from '../src/parser/office-strategy.js';
import { XMindParserStrategy } from '../src/parser/xmind-strategy.js';
import { Harness } from '../src/harness/harness.js';
import type { ChatFunction, HarnessConfig, HarnessResult, HarnessStepEvent } from '../src/harness/types.js';
import type { RuntimeTelemetryEvent } from '../src/harness/runtime-telemetry.js';
import { initializeToolSystem } from '../src/tools/index.js';
import type { AgentEvalCase } from './agent-eval-cases.js';

export interface EvalMetrics {
  task_success_rate: number;
  tool_call_rate: number;
  first_tool_latency: number;
  no_tool_final_rate: number;
  verification_rate: number;
  repeat_failure_rate: number;
  memory_interference_rate: number;
  tokens_per_successful_task: number;
  compaction_saved_tokens: number;
  compaction_recovery_success_rate: number;
}

export interface CaseResult {
  id: string;
  category: AgentEvalCase['category'];
  passed: boolean;
  metrics: EvalMetrics;
  failures: string[];
  workspace?: string;
}

export interface RunAgentEvalCaseOptions {
  chatFn: ChatFunction;
  keepWorkspace?: boolean;
}

interface JudgeCommandResult {
  command: string;
  success: boolean;
  output: string;
}

const CASE_SYSTEM_PROMPT = [
  'You are running inside an isolated local eval workspace.',
  'Use the available file and shell tools to complete the user request.',
  'Inspect files before editing them.',
  'When the request asks for verification, run the exact verification command before finalizing.',
  'Do not claim a file was changed unless you actually used tools to change it.',
].join('\n');

export async function runAgentEvalCase(
  testCase: AgentEvalCase,
  options: RunAgentEvalCaseOptions,
): Promise<CaseResult> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `ice-agent-eval-${testCase.id}-`));
  const sessionDir = path.join(workspace, '.icecoder', 'sessions');
  const memoryDir = path.join(workspace, '.icecoder', 'memory-files');
  const initialFiles = new Map<string, string>();
  const events: HarnessStepEvent[] = [];

  try {
    await writeCaseFiles(workspace, testCase.files, initialFiles);
    if (testCase.memoryFiles) {
      await writeCaseFiles(memoryDir, testCase.memoryFiles);
    }
    await fs.mkdir(sessionDir, { recursive: true });

    const fileParser = new FileParser();
    fileParser.registerStrategy(new HtmlParserStrategy());
    fileParser.registerStrategy(new OfficeParserStrategy());
    fileParser.registerStrategy(new XMindParserStrategy());

    const { registry, executor } = initializeToolSystem({
      workDir: workspace,
      sessionId: testCase.id,
      fileParser,
      executorConfig: { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 30_000 },
    });
    const toolDefs = testCase.toolsDisabled ? [] : registry.getDefinitions();

    const harnessConfig: HarnessConfig = {
      context: {
        systemPrompt: CASE_SYSTEM_PROMPT,
        tools: toolDefs,
        memoryPrompt: buildMemoryPrompt(testCase),
        environment: {
          workingDirectory: workspace,
          platform: process.platform,
          currentDate: new Date().toISOString().slice(0, 10),
        },
      },
      loop: {
        maxRounds: testCase.maxRounds ?? 8,
        timeout: 120_000,
        tokenBudget: 250_000,
      },
      permissions: [],
      skipPermissionChecks: true,
      compactionThreshold: testCase.compactionThreshold ?? 40,
      compactionTokenThreshold: testCase.compactionTokenThreshold ?? 80_000,
      compactionKeepRecent: 4,
      compactionEnableLLMSummary: false,
      memoryDir,
      sessionDir,
      sessionId: testCase.id,
      workspaceRoot: workspace,
    };

    const harness = new Harness(harnessConfig, executor);
    const result = await harness.run(
      buildPrompt(testCase),
      options.chatFn,
      event => events.push(event),
    );

    const judgeResults = await runJudgeCommands(workspace, testCase.verifyCommands);
    const telemetry = await readTelemetryEvents(path.join(workspace, '.icecoder', 'runtime', 'telemetry.jsonl'));
    const caseResult = await scoreCase({
      testCase,
      workspace,
      initialFiles,
      result,
      events,
      telemetry,
      judgeResults,
    });

    return options.keepWorkspace
      ? { ...caseResult, workspace }
      : caseResult;
  } catch (error) {
    return {
      id: testCase.id,
      category: testCase.category,
      passed: false,
      metrics: zeroMetrics(),
      failures: [error instanceof Error ? error.message : String(error)],
      ...(options.keepWorkspace ? { workspace } : {}),
    };
  } finally {
    if (!options.keepWorkspace) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}

function buildPrompt(testCase: AgentEvalCase): string {
  const verify = testCase.verifyCommands.length > 0
    ? `\n\nVerification command(s) you should run before final: ${testCase.verifyCommands.join(' && ')}`
    : '';
  return `${testCase.prompt}${verify}`;
}

function buildMemoryPrompt(testCase: AgentEvalCase): string | undefined {
  if (!testCase.memoryFiles || Object.keys(testCase.memoryFiles).length === 0) return undefined;
  return [
    '# Recalled Memory',
    ...Object.entries(testCase.memoryFiles).map(([file, content]) => `## ${file}\n${content}`),
  ].join('\n\n');
}

async function writeCaseFiles(
  root: string,
  files: Record<string, string>,
  initialFiles?: Map<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    initialFiles?.set(normalizePath(relativePath), content);
  }
}

async function runJudgeCommands(workspace: string, commands: string[]): Promise<JudgeCommandResult[]> {
  const results: JudgeCommandResult[] = [];
  for (const command of commands) {
    results.push(await runJudgeCommand(workspace, command));
  }
  return results;
}

function runJudgeCommand(workspace: string, command: string): Promise<JudgeCommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, {
      cwd: workspace,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: '1' },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', error => {
      resolve({ command, success: false, output: error.message });
    });
    child.on('close', code => {
      resolve({ command, success: code === 0, output });
    });
  });
}

async function readTelemetryEvents(filePath: string): Promise<RuntimeTelemetryEvent[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await fs.readFile(filePath, 'utf-8').catch(() => '');
    const events = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => safeJsonParse<RuntimeTelemetryEvent>(line))
      .filter((event): event is RuntimeTelemetryEvent => !!event);
    if (events.some(event => event.type === 'summary')) return events;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return [];
}

function safeJsonParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

async function scoreCase(args: {
  testCase: AgentEvalCase;
  workspace: string;
  initialFiles: Map<string, string>;
  result: HarnessResult;
  events: HarnessStepEvent[];
  telemetry: RuntimeTelemetryEvent[];
  judgeResults: JudgeCommandResult[];
}): Promise<CaseResult> {
  const { testCase, workspace, initialFiles, result, events, telemetry, judgeResults } = args;
  const failures: string[] = [];
  const assertionFailures = await evaluateAssertions(workspace, initialFiles, testCase);
  failures.push(...assertionFailures);

  for (const judge of judgeResults) {
    if (!judge.success) {
      failures.push(`judge verification failed: ${judge.command}\n${trimForFailure(judge.output)}`);
    }
  }

  const toolEvents = events.filter(event => event.type === 'tool_call' || event.type === 'tool_result');
  const toolCallEvents = events.filter(event => event.type === 'tool_call');
  const finalEvent = [...events].reverse().find(event => event.type === 'final');
  const agentVerificationPassed = didAgentRunVerification(events, testCase.verifyCommands);
  const anyFileChanged = await didAnyCaseFileChange(workspace, initialFiles);

  if (testCase.expected.requiresTool && toolCallEvents.length === 0) {
    failures.push('expected tool use');
  }
  if (testCase.expected.requiresVerification && !agentVerificationPassed) {
    failures.push('expected agent-run verification');
  }
  if (testCase.expected.allowFileChanges === false && anyFileChanged) {
    failures.push('files changed while case expected no mutations');
  }

  const summary = telemetry
    .filter((event): event is Extract<RuntimeTelemetryEvent, { type: 'summary' }> => event.type === 'summary')
    .at(-1);
  const compactionEvents = telemetry
    .filter((event): event is Extract<RuntimeTelemetryEvent, { type: 'compaction' }> => event.type === 'compaction');
  const compactionSavedTokens = compactionEvents.reduce((sum, event) => sum + event.savedTokens, 0);
  const noToolFinal = testCase.expected.requiresTool && toolCallEvents.length === 0 && finalEvent?.type === 'final';
  const compactionHappened = compactionEvents.length > 0;
  const postCompactionToolProgress = didToolRunAfterHardCompaction(events);
  if (testCase.category === 'compression' && !compactionHappened) {
    failures.push('expected hard compaction telemetry event');
  }
  if (testCase.category === 'compression' && !postCompactionToolProgress) {
    failures.push('expected tool progress after hard compaction');
  }
  const taskSucceeded = failures.length === 0;
  const memoryInterference = testCase.category === 'memory-conflict' && assertionFailures.length > 0 ? 1 : 0;
  const compactionRecoverySucceeded = testCase.category === 'compression'
    && compactionHappened
    && postCompactionToolProgress
    && taskSucceeded
    && agentVerificationPassed
    && !noToolFinal;

  const metrics: EvalMetrics = {
    task_success_rate: taskSucceeded ? 1 : 0,
    tool_call_rate: toolCallEvents.length > 0 ? 1 : 0,
    first_tool_latency: firstToolLatency(events),
    no_tool_final_rate: noToolFinal ? 1 : 0,
    verification_rate: agentVerificationPassed ? 1 : 0,
    repeat_failure_rate: repeatFailureRate(toolEvents),
    memory_interference_rate: memoryInterference,
    tokens_per_successful_task: taskSucceeded
      ? result.loopState.totalInputTokens + result.loopState.totalOutputTokens
      : summary?.tokensPerSuccessfulTask ?? 0,
    compaction_saved_tokens: compactionSavedTokens || summary?.compactionSavedTokens || 0,
    compaction_recovery_success_rate: compactionRecoverySucceeded ? 1 : 0,
  };

  return {
    id: testCase.id,
    category: testCase.category,
    passed: failures.length === 0,
    metrics,
    failures,
  };
}

async function evaluateAssertions(
  workspace: string,
  initialFiles: Map<string, string>,
  testCase: AgentEvalCase,
): Promise<string[]> {
  const failures: string[] = [];
  for (const assertion of testCase.assertions) {
    const relativePath = normalizePath(assertion.path);
    const current = await fs.readFile(path.join(workspace, relativePath), 'utf-8').catch(() => undefined);
    if (current === undefined) {
      failures.push(`missing file: ${relativePath}`);
      continue;
    }
    if (assertion.contains && !current.includes(assertion.contains)) {
      failures.push(`${relativePath} does not contain ${JSON.stringify(assertion.contains)}`);
    }
    if (assertion.notContains && current.includes(assertion.notContains)) {
      failures.push(`${relativePath} still contains ${JSON.stringify(assertion.notContains)}`);
    }
    if (assertion.unchanged && current !== initialFiles.get(relativePath)) {
      failures.push(`${relativePath} changed unexpectedly`);
    }
  }
  return failures;
}

async function didAnyCaseFileChange(workspace: string, initialFiles: Map<string, string>): Promise<boolean> {
  for (const [relativePath, initial] of initialFiles) {
    const current = await fs.readFile(path.join(workspace, relativePath), 'utf-8').catch(() => undefined);
    if (current !== initial) return true;
  }
  return false;
}

function didAgentRunVerification(events: HarnessStepEvent[], verifyCommands: string[]): boolean {
  if (verifyCommands.length === 0) return false;
  return events.some(event => {
    if (event.type !== 'tool_result' || event.toolName !== 'run_command' || event.toolSuccess !== true) {
      return false;
    }
    const command = String(event.toolArgs?.command ?? event.toolArgs?.cmd ?? '');
    return verifyCommands.some(expected => command.includes(expected));
  });
}

function firstToolLatency(events: HarnessStepEvent[]): number {
  const index = events.findIndex(event => event.type === 'tool_call');
  if (index < 0) return 0;
  return events[index]?.iteration ?? index + 1;
}

function repeatFailureRate(events: HarnessStepEvent[]): number {
  const failures = events.filter(event => event.type === 'tool_result' && event.toolSuccess === false);
  if (failures.length === 0) return 0;

  let repeated = 0;
  let previous = '';
  for (const event of failures) {
    const signature = `${event.toolName ?? 'unknown'}:${JSON.stringify(event.toolArgs ?? {})}`;
    if (signature === previous) repeated++;
    previous = signature;
  }
  return repeated / failures.length;
}

function didToolRunAfterHardCompaction(events: HarnessStepEvent[]): boolean {
  const compactionIndex = events.findIndex(event =>
    event.type === 'compaction'
    && !String(event.content ?? '').startsWith('micro:'),
  );
  if (compactionIndex < 0) return false;
  return events.slice(compactionIndex + 1).some(event => event.type === 'tool_call');
}

function trimForFailure(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}...` : trimmed;
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

export function zeroMetrics(): EvalMetrics {
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
    compaction_recovery_success_rate: 0,
  };
}
