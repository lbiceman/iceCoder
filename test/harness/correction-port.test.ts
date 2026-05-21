import { describe, expect, it } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
import { MessageCorrectionPort } from '../../src/harness/supervisor/correction-port.js';

describe('CorrectionPort - Batch 5', () => {
  it('is the single visible outlet for supervisor correction blocks', () => {
    const messages: UnifiedMessage[] = [];
    const port = new MessageCorrectionPort(messages);

    port.inject(
      { kind: 'graph_hint', content: '[Graph] Use read_file before edit_file.' },
      { phase: 'takeover', source: 'supervisor' },
    );

    expect(messages).toEqual([
      { role: 'user', content: '[Graph] Use read_file before edit_file.' },
    ]);
  });

  it('still suppresses takeover-class blocks in free mode (phase=takeover is the only banned kind)', () => {
    const messages: UnifiedMessage[] = [];
    const port = new MessageCorrectionPort(messages);

    port.inject(
      { kind: 'takeover', content: '[Supervisor] taking over due to drift.' },
      { phase: 'free', source: 'supervisor' },
    );

    expect(messages).toEqual([]);
  });

  it('keeps recovery-class warnings injectable in free mode so self-correction never goes silent', () => {
    // W7：CorrectionBudget 落地之前，recovery 类（如 repeated-failure / branch-budget warning /
    //     6-round burnout）是 free 段最后的硬阈值提示，整类抑制会让 adaptive 失去自我恢复。
    const messages: UnifiedMessage[] = [];
    const port = new MessageCorrectionPort(messages);

    port.inject(
      { kind: 'recovery', content: '[System] Warning: repeated failures, switch strategy.' },
      { phase: 'free', source: 'supervisor' },
    );

    expect(messages).toEqual([
      { role: 'user', content: '[System] Warning: repeated failures, switch strategy.' },
    ]);
  });
});
