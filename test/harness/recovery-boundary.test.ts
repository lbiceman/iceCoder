import { describe, expect, it } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
import type { CorrectionBlock, CorrectionSource, SupervisorPhase } from '../../src/types/supervisor.js';
import type { BoundaryDecision } from '../../src/harness/supervisor/recovery-boundary.js';
import { CorrectionBudgetTracker } from '../../src/harness/supervisor/correction-budget.js';
import { MessageCorrectionPort } from '../../src/harness/supervisor/correction-port.js';
import { RecoveryBoundary } from '../../src/harness/supervisor/recovery-boundary.js';

describe('RecoveryBoundary - L2-7', () => {
  const boundary = new RecoveryBoundary();

  describe('mayInjectCorrection (pure decision)', () => {
    it('rejects supervisor takeover-class blocks in free phase', () => {
      expect(boundary.mayInjectCorrection({
        phase: 'free',
        source: 'supervisor',
        blockKind: 'takeover',
      })).toEqual({ allowed: false, reason: 'free_phase_rejects_takeover_block' });
    });

    it('allows supervisor recovery / graph_hint in free with budgetCountable=true', () => {
      expect(boundary.mayInjectCorrection({
        phase: 'free',
        source: 'supervisor',
        blockKind: 'recovery',
      })).toEqual({ allowed: true, budgetCountable: true });
      expect(boundary.mayInjectCorrection({
        phase: 'free',
        source: 'supervisor',
        blockKind: 'graph_hint',
      })).toEqual({ allowed: true, budgetCountable: true });
    });

    it('allows supervisor shadow_diagnostic in free with budgetCountable=false', () => {
      expect(boundary.mayInjectCorrection({
        phase: 'free',
        source: 'supervisor',
        blockKind: 'shadow_diagnostic',
      })).toEqual({ allowed: true, budgetCountable: false });
    });

    it('allows non-supervisor recovery in free with budgetCountable=false', () => {
      expect(boundary.mayInjectCorrection({
        phase: 'free',
        source: 'lifecycle',
        blockKind: 'recovery',
      })).toEqual({ allowed: true, budgetCountable: false });
    });

    it('rejects non-supervisor C-class blocks in takeover phase (§11)', () => {
      for (const source of ['lifecycle', 'memory', 'compaction'] as const) {
        expect(boundary.mayInjectCorrection({
          phase: 'takeover',
          source,
          blockKind: 'recovery',
        })).toEqual({ allowed: false, reason: 'takeover_phase_requires_supervisor_source' });
      }
    });

    it('allows supervisor blocks in takeover phase with budgetCountable=false', () => {
      expect(boundary.mayInjectCorrection({
        phase: 'takeover',
        source: 'supervisor',
        blockKind: 'takeover',
      })).toEqual({ allowed: true, budgetCountable: false });
      expect(boundary.mayInjectCorrection({
        phase: 'takeover',
        source: 'supervisor',
        blockKind: 'recovery',
      })).toEqual({ allowed: true, budgetCountable: false });
    });

    it('rejects non-supervisor takeover/recovery blocks in handoff_pending and cooldown', () => {
      for (const phase of ['handoff_pending', 'cooldown'] as const) {
        expect(boundary.mayInjectCorrection({
          phase,
          source: 'lifecycle',
          blockKind: 'recovery',
        })).toEqual({ allowed: false, reason: 'handoff_phase_rejects_non_supervisor_recovery' });
        expect(boundary.mayInjectCorrection({
          phase,
          source: 'memory',
          blockKind: 'takeover',
        })).toEqual({ allowed: false, reason: 'handoff_phase_rejects_non_supervisor_recovery' });
      }
    });

    it('allows lifecycle graph_hint / shadow_diagnostic in handoff_pending and cooldown', () => {
      for (const phase of ['handoff_pending', 'cooldown'] as const) {
        expect(boundary.mayInjectCorrection({
          phase,
          source: 'lifecycle',
          blockKind: 'graph_hint',
        })).toEqual({ allowed: true, budgetCountable: false });
        expect(boundary.mayInjectCorrection({
          phase,
          source: 'memory',
          blockKind: 'shadow_diagnostic',
        })).toEqual({ allowed: true, budgetCountable: false });
      }
    });
  });

  describe('MessageCorrectionPort integration', () => {
    it('drops boundary-rejected inject without consuming budget; invokes onBoundaryRejected', () => {
      const messages: UnifiedMessage[] = [];
      const budget = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
      const rejections: string[] = [];
      const port = new MessageCorrectionPort(messages, {
        recoveryBoundary: boundary,
        budget,
        onBoundaryRejected: ({ reason, block }) => {
          rejections.push(`${reason}:${block.kind}`);
        },
      });

      port.inject(
        { kind: 'takeover', content: 'should be dropped' },
        { phase: 'free', source: 'supervisor' },
      );

      expect(messages).toEqual([]);
      expect(rejections).toEqual(['free_phase_rejects_takeover_block:takeover']);
      expect(budget.snapshot().used).toBe(0);
    });

    it('allows supervisor recovery in free with boundary attached (budget unbound)', () => {
      const messages: UnifiedMessage[] = [];
      const port = new MessageCorrectionPort(messages, { recoveryBoundary: boundary });

      port.inject(
        { kind: 'recovery', content: 'self-correction' },
        { phase: 'free', source: 'supervisor' },
      );

      expect(messages).toEqual([
        { role: 'user', content: 'self-correction' },
      ]);
    });

    it('rejects non-supervisor lifecycle inject in takeover phase via boundary', () => {
      const messages: UnifiedMessage[] = [];
      const rejections: string[] = [];
      const port = new MessageCorrectionPort(messages, {
        recoveryBoundary: boundary,
        onBoundaryRejected: ({ reason }) => rejections.push(reason),
      });

      port.inject(
        { kind: 'recovery', content: 'lifecycle should not write here' },
        { phase: 'takeover', source: 'lifecycle' },
      );

      expect(messages).toEqual([]);
      expect(rejections).toEqual(['takeover_phase_requires_supervisor_source']);
    });

    it('boundary+budget: only budgetCountable injects consume free segment quota', () => {
      const messages: UnifiedMessage[] = [];
      const budget = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
      const port = new MessageCorrectionPort(messages, {
        recoveryBoundary: boundary,
        budget,
      });

      // takeover → boundary 拒，不计 budget
      port.inject(
        { kind: 'takeover', content: 'dropped' },
        { phase: 'free', source: 'supervisor' },
      );
      expect(budget.snapshot().used).toBe(0);

      // shadow_diagnostic → 放行但不计 budget
      port.inject(
        { kind: 'shadow_diagnostic', content: 'diag' },
        { phase: 'free', source: 'supervisor' },
      );
      expect(budget.snapshot().used).toBe(0);
      expect(messages).toHaveLength(1);

      // recovery → 计 budget（第 1 次 OK）
      port.inject(
        { kind: 'recovery', content: 'first recovery' },
        { phase: 'free', source: 'supervisor' },
      );
      expect(budget.snapshot().used).toBe(1);
      expect(messages).toHaveLength(2);

      // recovery → 超 budget 拒
      port.inject(
        { kind: 'recovery', content: 'second recovery' },
        { phase: 'free', source: 'supervisor' },
      );
      expect(budget.snapshot()).toEqual({ used: 1, max: 1, rejected: 1 });
      expect(messages).toHaveLength(2);
    });

    it('falls back to legacy shouldSuppress when boundary is omitted (backward compatibility)', () => {
      const messages: UnifiedMessage[] = [];
      const port = new MessageCorrectionPort(messages);

      port.inject(
        { kind: 'takeover', content: 'legacy supressed' },
        { phase: 'free', source: 'supervisor' },
      );

      expect(messages).toEqual([]);
    });
  });
});

function computeExpectedForMatrix(
  phase: SupervisorPhase,
  source: CorrectionSource,
  blockKind: CorrectionBlock['kind'],
): BoundaryDecision {
  if (phase === 'free' && source === 'supervisor' && blockKind === 'takeover') {
    return { allowed: false, reason: 'free_phase_rejects_takeover_block' };
  }
  if (phase === 'takeover' && source !== 'supervisor') {
    return { allowed: false, reason: 'takeover_phase_requires_supervisor_source' };
  }
  if (
    (phase === 'handoff_pending' || phase === 'cooldown')
    && source !== 'supervisor'
    && (blockKind === 'takeover' || blockKind === 'recovery')
  ) {
    return { allowed: false, reason: 'handoff_phase_rejects_non_supervisor_recovery' };
  }
  const budgetCountable = phase === 'free'
    && source === 'supervisor'
    && (blockKind === 'recovery' || blockKind === 'graph_hint');
  return { allowed: true, budgetCountable };
}

describe('RecoveryBoundary - full 4×4×4 matrix (P2-1)', () => {
  const phases = ['free', 'takeover', 'handoff_pending', 'cooldown'] as const;
  const sources = ['supervisor', 'lifecycle', 'memory', 'compaction'] as const;
  const kinds = ['takeover', 'recovery', 'graph_hint', 'shadow_diagnostic'] as const;

  const matrix = phases.flatMap(phase =>
    sources.flatMap(source =>
      kinds.map(blockKind => [phase, source, blockKind] as const),
    ),
  );

  it.each(matrix)(
    'phase=%s source=%s kind=%s 对齐 §19.6',
    (phase, source, blockKind) => {
      const expected = computeExpectedForMatrix(phase, source, blockKind);
      expect(new RecoveryBoundary().mayInjectCorrection({ phase, source, blockKind }))
        .toEqual(expected);
    },
  );
});
