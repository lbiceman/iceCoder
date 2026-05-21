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

  // W7：free 段仅抑制 takeover 类长策略（接管文案是 phase=takeover 的专属）。
  //     recovery 类是熔断前的硬阈值提示（如 "Repeated failed tool call detected"、
  //     branch budget warning、6 轮全失败警告），是 free 段最后的自纠偏路径，
  //     在 CorrectionBudget 真正落地之前不应整类抑制；否则 adaptive 接通后
  //     free 段会失去自我恢复能力。
  return block.kind === 'takeover';
}
