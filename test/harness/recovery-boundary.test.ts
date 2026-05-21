import { describe, expect, it } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
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

    it('allows supervisor recovery / graph_hint blocks in free phase (budget handled separately)', () => {
      expect(boundary.mayInjectCorrection({
        phase: 'free',
        source: 'supervisor',
        blockKind: 'recovery',
      })).toEqual({ allowed: true });
      expect(boundary.mayInjectCorrection({
        phase: 'free',
        source: 'supervisor',
        blockKind: 'graph_hint',
      })).toEqual({ allowed: true });
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

    it('allows supervisor blocks in takeover phase (entry point for §10 main path)', () => {
      expect(boundary.mayInjectCorrection({
        phase: 'takeover',
        source: 'supervisor',
        blockKind: 'takeover',
      })).toEqual({ allowed: true });
      expect(boundary.mayInjectCorrection({
        phase: 'takeover',
        source: 'supervisor',
        blockKind: 'recovery',
      })).toEqual({ allowed: true });
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
        })).toEqual({ allowed: true });
        expect(boundary.mayInjectCorrection({
          phase,
          source: 'memory',
          blockKind: 'shadow_diagnostic',
        })).toEqual({ allowed: true });
      }
    });
  });

  describe('MessageCorrectionPort integration', () => {
    it('drops boundary-rejected inject without consuming budget; invokes onBoundaryRejected', () => {
      const messages: UnifiedMessage[] = [];
      const rejections: string[] = [];
      const port = new MessageCorrectionPort(messages, {
        recoveryBoundary: boundary,
        onBoundaryRejected: ({ reason, block }) => {
          rejections.push(`${reason}:${block.kind}`);
        },
      });

      // free + supervisor + takeover → boundary 拒绝
      port.inject(
        { kind: 'takeover', content: 'should be dropped' },
        { phase: 'free', source: 'supervisor' },
      );

      expect(messages).toEqual([]);
      expect(rejections).toEqual(['free_phase_rejects_takeover_block:takeover']);
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
