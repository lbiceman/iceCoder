import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ModeDecisionEngine,
  formatForcedReasonHuman,
  shouldExitForcedMode,
  sortSignalsByPrecedence,
} from '../../src/harness/supervisor/mode-decision-engine.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { TaskRiskClassifier } from '../../src/harness/supervisor/task-risk-classifier.js';
import type {
  ModeDecisionContext,
  ModeSignal,
  RuntimeExecutionState,
} from '../../src/types/supervisor.js';

const cfg = defaultSupervisorConfig().executionMode!;
const sourceRoot = path.join(process.cwd(), 'src');

function state(overrides: Partial<RuntimeExecutionState> = {}): RuntimeExecutionState {
  return {
    round: 1,
    taskGraphActive: false,
    pendingStepCount: 0,
    writeTargetsThisRound: 0,
    plannedWriteTargets: 0,
    accumulatedDiffLines: 0,
    branchSwitchedThisRound: false,
    checkpointResumedThisSession: false,
    lastToolSuccess: true,
    recoveryPending: false,
    branchDebt: 0,
    stableRounds: cfg.stableRoundsExitThreshold,
    activeGraphHasImplementNode: false,
    readonlyToolNames: cfg.readonlyToolNames,
    plannedToolNames: [],
    forcedEntryRound: null,
    forcedTaskBearingRoundsSinceEntry: cfg.forcedMinDwellRounds,
    ...overrides,
  };
}

function context(overrides: Partial<ModeDecisionContext> = {}): ModeDecisionContext {
  const runtimeState = overrides.state ?? state();
  return {
    round: runtimeState.round,
    executionMode: 'free',
    executionModeLockRemaining: 0,
    supervisorPhase: 'free',
    supervisorMode: 'adaptive',
    riskLevel: 'L0_observation',
    state: runtimeState,
    signals: [],
    ...overrides,
  };
}

async function listSourceFiles(dir = sourceRoot): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return fullPath.endsWith('.ts') ? [fullPath] : [];
  }));
  return files.flat();
}

function relativeSourcePath(file: string): string {
  return path.relative(process.cwd(), file).replaceAll(path.sep, '/');
}

describe('Execution mode acceptance - Batch 6 / T13', () => {
  it('keeps L0 readonly plans in free mode and away from step-gated forced execution', () => {
    const readonlyState = state({
      plannedToolNames: ['read_file', 'search'],
      plannedWriteTargets: 0,
      writeTargetsThisRound: 0,
    });
    const classifier = new TaskRiskClassifier(cfg);
    const decision = new ModeDecisionEngine(cfg).evaluate(context({
      riskLevel: classifier.classify(readonlyState),
      state: readonlyState,
    }));

    expect(classifier.classify(readonlyState)).toBe('L0_observation');
    expect(decision).toEqual({ action: 'keep', mode: 'free' });
  });

  it('enters forced when pendingStepCount reaches the frozen threshold', () => {
    const decision = new ModeDecisionEngine(cfg).evaluate(context({
      state: state({ pendingStepCount: cfg.pendingStepsEnterThreshold }),
      riskLevel: 'L2_structural',
    }));

    expect(decision).toMatchObject({
      action: 'enter_forced',
      enteredBy: ['pending_steps'],
      primaryReason: 'pending_steps',
    });
  });

  it('orders simultaneous signals by P0 precedence and exposes the same human reason', () => {
    const signals: ModeSignal[] = ['multi_write', 'tool_failure', 'checkpoint_resumed', 'pending_steps'];
    const ordered = sortSignalsByPrecedence(signals);
    const decision = new ModeDecisionEngine(cfg).evaluate(context({
      signals,
      state: state({ plannedWriteTargets: cfg.writeTargetsEnterThreshold + 1 }),
    }));

    expect(ordered).toEqual(['checkpoint_resumed', 'pending_steps', 'tool_failure', 'multi_write']);
    expect(decision).toMatchObject({
      action: 'enter_forced',
      enteredBy: ordered,
      primaryReason: 'checkpoint_resumed',
    });
    expect(formatForcedReasonHuman(ordered)).toBe(
      'forced because checkpoint_resumed + pending_steps + tool_failure + multi_write',
    );
  });

  it('enforces I10 by denying exit before any task-bearing forced round', () => {
    expect(shouldExitForcedMode(
      state({ forcedTaskBearingRoundsSinceEntry: 0 }),
      cfg,
      0,
      [],
    )).toBe(false);
  });

  it('allows forced exit only after dwell, stability, no pending work, and no recovery signal', () => {
    const stableState = state({
      forcedTaskBearingRoundsSinceEntry: cfg.forcedMinDwellRounds,
      pendingStepCount: 0,
      plannedWriteTargets: 0,
      stableRounds: cfg.stableRoundsExitThreshold,
      recoveryPending: false,
      branchDebt: 0,
    });

    expect(shouldExitForcedMode(stableState, cfg, 0, [])).toBe(true);
    expect(shouldExitForcedMode(stableState, cfg, 0, ['recovery_pending'])).toBe(false);
  });

  it('does not treat user-goal keywords or inferIntent as forced-entry inputs', async () => {
    const sourceFiles = await listSourceFiles();
    const forbiddenRefs: string[] = [];

    // §19.1 / §8.3 / §8.7 明确允许下列「接管候选信号路径」消费 goal/intent（仅作为 takeover
    // 候选信号 / 模板图建图输入，不直接切 executionMode）。这些文件不计入 T13 forced-entry 关键字扫描。
    const goalDriftAllowed = new Set([
      'src/harness/supervisor/goal-drift-detector.ts',
      'src/harness/supervisor/supervisor-bridge.ts',
      'src/harness/supervisor/retrospective-graph-builder.ts',
    ]);

    for (const file of sourceFiles) {
      const rel = relativeSourcePath(file);
      if (!rel.startsWith('src/harness/supervisor/')) continue;
      if (goalDriftAllowed.has(rel)) continue;
      const content = await fs.readFile(file, 'utf-8');
      if (/\b(userGoal|goal|intent|inferIntent)\b/.test(content)) {
        forbiddenRefs.push(rel);
      }
    }

    expect(forbiddenRefs).toEqual([]);
  });

  it('keeps ICE_SUPERVISOR environment reads inside global config resolution', async () => {
    const allowed = new Set([
      'src/harness/supervisor/mode-controller.ts',
      'src/harness/supervisor/supervisor-config.ts',
    ]);
    const directReads: string[] = [];

    for (const file of await listSourceFiles()) {
      const content = await fs.readFile(file, 'utf-8');
      if (/(?:process\.env|env)\.ICE_SUPERVISOR_[A-Z_]+/.test(content)) {
        directReads.push(relativeSourcePath(file));
      }
    }

    expect(directReads.filter(file => !allowed.has(file))).toEqual([]);
  });

  it('keeps Harness executionMode mutations routed through the constraints helper', async () => {
    const allowed = new Set(['src/harness/supervisor/execution-mode-constraints.ts']);
    const directMutations: string[] = [];

    for (const file of await listSourceFiles()) {
      const content = await fs.readFile(file, 'utf-8');
      if (/\bstate\.executionMode\s*=/.test(content)) {
        directMutations.push(relativeSourcePath(file));
      }
    }

    expect(directMutations.filter(file => !allowed.has(file))).toEqual([]);
  });
});
