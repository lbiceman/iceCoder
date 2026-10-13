import type { UnifiedMessage } from '../llm/types.js';
import type { StopHookResult } from './stop-hooks.js';

/**
 * 模型「我还要接着干」的前向承诺信号。
 *
 * 注意：本钩子在 `harness-round-no-tools.ts` 中已经被状态门控保护：
 * - 问答 / 查看 / 文档类意图直接跳过；
 * - 没有 pendingWork 且已动过工具的轮次直接跳过。
 *
 * 因此这里只需要识别 **模型自承未完成** 的明确文本承诺，将其拉回到工具调用。
 * 按分句匹配：承诺必须出现在分句开头、主语是模型自己。「还需要注意…」「Next step for
 * the user…」「This will fix…」这类提醒 / 描述不算。
 */
const WORK_VERB_ZH = '(?:继续|接着|再|去)?(?:修改|修复|实现|更新|完成|处理|添加|补充|编写|写|运行|检查|调整|重构|创建|执行|改|补)';
const WORK_VERB_EN = '(?:continue|update|fix|implement|add|finish|complete|write|run|check|adjust|refactor|create|handle|change|modify)';

const FORWARD_CLAUSE_PATTERNS: readonly RegExp[] = [
  new RegExp(`^(?:接下来|下一步|然后|之后|现在)?(?:我们?)(?:还)?(?:需要|会|将|要|得|准备)${WORK_VERB_ZH}`),
  new RegExp(`^(?:接下来|下一步)(?:是|要|将)?${WORK_VERB_ZH}`),
  /^(?:任务|工作|修改|实现)?(?:尚|仍|还)未完成/,
  new RegExp(`^(?:(?:and|so|next|now|then),?\\s+){0,2}(?:I|we)(?:'ll| will| am going to| are going to| need to| still need to| have to| must)\\s+(?:now\\s+)?${WORK_VERB_EN}\\b`, 'i'),
  new RegExp(`^let me (?:now\\s+)?${WORK_VERB_EN}\\b`, 'i'),
  /^(?:(?:I|we) )?still need to\b/i,
  /^(?:the )?next step (?:is|will be) to\b/i,
  /^(?:the )?(?:task|work) is (?:not (?:yet )?(?:complete|finished|done)|incomplete)\b/i,
];

const ADDRESSED_TO_USER = /你|您|用户|\b(?:you|your|the user)\b/i;

export function detectIncompleteForwardSignal(lastContent: string): boolean {
  const text = lastContent.trim();
  if (!text) return false;
  const clauses = text
    .split(/[。！？!?；;，,\n]|\.(?:\s|$)/)
    .map(clause => clause.replace(/^[\s>*#•\-–]+|^\d+[.)、]\s*/g, '').trim())
    .filter(Boolean);
  return clauses.some(clause =>
    !ADDRESSED_TO_USER.test(clause)
    && FORWARD_CLAUSE_PATTERNS.some(pattern => pattern.test(clause)),
  );
}

/**
 * Web 默认停止钩子：仅在模型自承未完成时拦截停手。
 *
 * 用户意图过滤、pendingWork 判断已由 Harness 主循环承担，本函数不再扫描用户输入。
 */
export function evaluateIncompleteTaskStopHook(
  _messages: UnifiedMessage[],
  lastContent: string,
): StopHookResult {
  const hasIncomplete = detectIncompleteForwardSignal(lastContent);
  return {
    shouldContinue: hasIncomplete,
    message: hasIncomplete
      ? 'You identified unfinished work. Continue by calling tools now — do not stop with analysis only.'
      : undefined,
    hookName: 'incomplete_task_check',
  };
}
