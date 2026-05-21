import type { UnifiedMessage } from '../../llm/types.js';
import type { CorrectionBlock, CorrectionPort, CorrectionSource, SupervisorPhase } from '../../types/supervisor.js';

export class MessageCorrectionPort implements CorrectionPort {
  constructor(private readonly messages: UnifiedMessage[]) {}

  inject(block: CorrectionBlock, ctx: { phase: SupervisorPhase; source: CorrectionSource }): void {
    if (shouldSuppress(block, ctx)) {
      return;
    }

    this.messages.push({ role: 'user', content: block.content });
  }
}

function shouldSuppress(block: CorrectionBlock, ctx: { phase: SupervisorPhase; source: CorrectionSource }): boolean {
  if (ctx.source !== 'supervisor' || ctx.phase !== 'free') {
    return false;
  }

  return block.kind === 'takeover' || block.kind === 'recovery';
}
