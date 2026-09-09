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

  it('does not derive a hard verification hint from task metadata', () => {
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
    expect('verificationHint' in pending).toBe(false);
  });

  it('recommended flow stays domain-neutral', () => {
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
    expect(plan.recommendedFlow.join(' ')).toContain('relevant observation');
    expect(plan.recommendedFlow.join(' ')).not.toMatch(/unit tests|source code|documentation/i);
  });
});
