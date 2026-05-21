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

  it('does not inject long supervisor strategy blocks in free mode', () => {
    const messages: UnifiedMessage[] = [];
    const port = new MessageCorrectionPort(messages);

    port.inject(
      { kind: 'recovery', content: '[System] Warning: repeated failures, switch strategy.' },
      { phase: 'free', source: 'supervisor' },
    );

    expect(messages).toEqual([]);
  });
});
