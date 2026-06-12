import { describe, it, expect } from 'vitest';
import { buildToolPlan, formatToolPlan } from '../../src/harness/tool-planner.js';

describe('buildToolPlan', () => {
  it('maps debug intent to concrete tool names', () => {
    const plan = buildToolPlan('investigate', {
      goal: 'g',
      intent: 'debug',
      phase: 'context',
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      verificationRequired: false,
      verificationStatus: 'not_required',
    });
    expect(plan.suggestedTools).toContain('read_file');
    expect(plan.suggestedTools).toContain('run_command');
    expect(plan.suggestedTools.length).toBeGreaterThanOrEqual(2);
  });

  it('formatToolPlan includes suggested tools line', () => {
    const text = formatToolPlan(buildToolPlan('fix tests'));
    expect(text).toContain('Suggested tools');
    expect(text).toContain('[Runtime Tool Planner]');
  });

  it('adds unit test hint when engineering changes pending tests', () => {
    const pending = buildToolPlan('fix bug', {
      goal: 'fix bug',
      intent: 'edit',
      phase: 'editing',
      filesRead: [],
      filesChanged: ['src/a.ts'],
      commandsRun: [],
      verificationRequired: true,
      verificationStatus: 'required',
    });
    expect(pending.verificationHint).toMatch(/unit tests/i);

    const passed = buildToolPlan('fix bug', {
      goal: 'fix bug',
      intent: 'edit',
      phase: 'verification',
      filesRead: [],
      filesChanged: ['src/a.ts'],
      commandsRun: ['npm test'],
      verificationRequired: true,
      verificationStatus: 'passed',
    });
    expect(passed.verificationHint).toBeUndefined();

    const mdOnly = buildToolPlan('write doc', {
      goal: 'write doc',
      intent: 'docs',
      phase: 'editing',
      filesRead: [],
      filesChanged: ['/tmp/out.md'],
      commandsRun: [],
      verificationRequired: true,
      verificationStatus: 'required',
    });
    expect(mdOnly.verificationHint).toBeUndefined();
  });

  it('recommended flow asks for unit tests before finishing on edit intent', () => {
    const plan = buildToolPlan('fix bug', {
      goal: 'fix bug',
      intent: 'edit',
      phase: 'editing',
      filesRead: [],
      filesChanged: ['src/a.ts'],
      commandsRun: [],
      verificationRequired: true,
      verificationStatus: 'required',
    });
    expect(plan.recommendedFlow.join(' ')).toMatch(/unit tests before finishing/i);
  });
});
