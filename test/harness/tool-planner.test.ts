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

  it('adds file deliverable hint only when confirmation pending', () => {
    const pending = buildToolPlan('write doc', {
      goal: 'write doc',
      intent: 'docs',
      phase: 'editing',
      filesRead: [],
      filesChanged: ['/tmp/out.md'],
      commandsRun: [],
      verificationRequired: true,
      verificationStatus: 'required',
      fileDeliverableWriteVersions: { '/tmp/out.md': 1 },
    });
    expect(pending.verificationHint).toMatch(/file_info|read_file/i);

    const confirmed = buildToolPlan('write doc', {
      goal: 'write doc',
      intent: 'docs',
      phase: 'verification',
      filesRead: [],
      filesChanged: ['/tmp/out.md'],
      commandsRun: [],
      verificationRequired: true,
      verificationStatus: 'passed',
      fileDeliverableWriteVersions: { '/tmp/out.md': 1 },
      fileDeliverableConfirmVersions: { '/tmp/out.md': 1 },
    });
    expect(confirmed.verificationHint).toBeUndefined();

    const engineering = buildToolPlan('fix bug', {
      goal: 'fix bug',
      intent: 'edit',
      phase: 'editing',
      filesRead: [],
      filesChanged: ['src/a.ts'],
      commandsRun: [],
      verificationRequired: true,
      verificationStatus: 'required',
    });
    expect(engineering.verificationHint).toMatch(/file_info|read_file/i);
  });

  it('recommended flow treats verification as optional for edit intent', () => {
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
    expect(plan.recommendedFlow.join(' ')).toMatch(/optional before finishing/i);
    expect(plan.recommendedFlow.join(' ')).not.toMatch(/appropriate verification command/i);
  });
});
