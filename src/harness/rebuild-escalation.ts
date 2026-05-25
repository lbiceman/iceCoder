import type { UnifiedMessage, ToolCall } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import { extractRunCommand } from './branch-budget-tool-path.js';
import { topFileEditFromInspect } from './supervisor/passive-observer.js';
import { buildVerificationDigest, isVerificationCommand } from './verification-digest.js';

export type RebuildEscalationTrigger =
  | 'consecutive_failures'
  | 'file_cap_verification_failed'
  | 'segment_renewal_budget';

export interface RebuildEscalationContext {
  topFile?: { path: string; count: number };
  failingTestPaths: string[];
  verificationDigest: string | null;
  lastVerificationCommand: string | null;
  recentFailureSnippets: string[];
  writeBypassGranted: boolean;
  commandBypassGranted: boolean;
}

function findAssistantToolCall(
  messages: UnifiedMessage[],
  toolIndex: number,
  toolCallId: string | undefined,
): ToolCall | undefined {
  if (!toolCallId) return undefined;
  for (let j = toolIndex - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const match = m.toolCalls.find(tc => tc.id === toolCallId);
    if (match) return match;
    break;
  }
  return undefined;
}

function isToolResultFailed(content: string): boolean {
  return content.includes('工具执行错误')
    || content.includes('Tool execution error')
    || content.includes('[BranchBudget / Blocked]');
}

function stripToolErrorPrefix(content: string): string {
  if (content.includes('[BranchBudget / Blocked]')) return '';
  return content.replace(/^(?:工具执行错误|Tool execution error)[:：][^\n]*\n+/m, '').trim();
}

/** 从 vitest / npm test 输出中提取失败测试路径（供 read_file 目标）。 */
export function parseFailingTestPaths(output: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /\bFAIL\s+(\S+\.test\.(?:ts|tsx|js|jsx))/gi,
    /\b(test\/\S+\.(?:test\.)?(?:ts|tsx|js|jsx))/gi,
    /❯\s*(\S+\.test\.(?:ts|tsx|js|jsx))/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(output)) !== null) {
      const p = match[1].replace(/^[❯>\s]+/, '');
      if (p && !p.includes('node_modules')) paths.add(p);
    }
  }
  return [...paths].slice(0, 4);
}

/** 从对话历史取最近一次失败的验收命令及其输出体（不含 BranchBudget 拦截文案）。 */
export function findLastFailedVerification(messages: UnifiedMessage[]): {
  command: string;
  outputBody: string;
} | null {
  let commandOnly: string | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (!isToolResultFailed(msg.content)) continue;

    const tc = findAssistantToolCall(messages, i, msg.toolCallId);
    if (!tc || tc.name !== 'run_command') continue;

    const command = extractRunCommand(tc.arguments);
    if (!command || !isVerificationCommand(command)) continue;

    if (!commandOnly) commandOnly = command;

    const body = stripToolErrorPrefix(msg.content);
    if (body) {
      return { command, outputBody: body };
    }
  }

  if (commandOnly) {
    return { command: commandOnly, outputBody: '' };
  }
  return null;
}

function collectRecentFailureSnippets(messages: UnifiedMessage[], max: number): string[] {
  const snippets: string[] = [];
  for (let i = messages.length - 1; i >= 0 && snippets.length < max; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (!isToolResultFailed(msg.content)) continue;
    snippets.unshift(msg.content.slice(0, 280));
  }
  return snippets;
}

/** BranchBudget 拦截 write/edit/run 时，附带最近 vitest 失败摘要。 */
export function appendVerificationEvidenceToBranchBlock(
  baseMessage: string,
  messages: UnifiedMessage[],
): string {
  const verification = findLastFailedVerification(messages);
  if (!verification?.outputBody) return baseMessage;

  const digest = buildVerificationDigest(verification.command, verification.outputBody);
  if (!digest) return baseMessage;

  const paths = parseFailingTestPaths(verification.outputBody);
  const parts = [baseMessage, '', '**Last verification evidence:**', digest];
  if (paths.length > 0) {
    parts.push('', `**Failing tests (read first):** ${paths.map(p => `\`${p}\``).join(', ')}`);
  }
  return parts.join('\n');
}

/** 同一实现文件达 BranchBudget 上限且验收仍失败 → 触发 rebuild（不依赖连续全失败轮次）。 */
export function shouldTriggerFileCapRebuild(args: {
  branchBudget?: BranchBudgetTracker;
  verificationStatus: string;
  rebuildEscalationInjected: boolean;
}): boolean {
  if (args.rebuildEscalationInjected || !args.branchBudget) return false;
  if (args.verificationStatus !== 'failed') return false;

  const topFile = topFileEditFromInspect(args.branchBudget.inspect().fileEdits);
  if (!topFile) return false;
  return args.branchBudget.wouldBlockFileEdit(topFile.path);
}

/** 第 5 轮 escalation：收集验收证据、卡点文件与最近失败摘要。 */
export function collectRebuildEscalationContext(
  messages: UnifiedMessage[],
  topFile: { path: string; count: number } | undefined,
): Omit<RebuildEscalationContext, 'writeBypassGranted' | 'commandBypassGranted'> {
  const verification = findLastFailedVerification(messages);
  const lastVerificationCommand = verification?.command ?? null;
  const outputBody = verification?.outputBody ?? '';
  const failingFromOutput = outputBody ? parseFailingTestPaths(outputBody) : [];
  const verificationDigest = lastVerificationCommand && outputBody
    ? buildVerificationDigest(lastVerificationCommand, outputBody)
    : null;

  return {
    topFile,
    failingTestPaths: failingFromOutput,
    verificationDigest,
    lastVerificationCommand,
    recentFailureSnippets: collectRecentFailureSnippets(messages, 3),
  };
}

/** 授予一次 write / 验收命令重试豁免（第 5 轮 rebuild 专用）。 */
export function applyRebuildEscalationBypasses(
  branchBudget: BranchBudgetTracker | undefined,
  topFile: { path: string; count: number } | undefined,
  lastVerificationCommand: string | null,
): Pick<RebuildEscalationContext, 'writeBypassGranted' | 'commandBypassGranted'> {
  let writeBypassGranted = false;
  let commandBypassGranted = false;

  if (branchBudget && topFile) {
    branchBudget.grantWriteBypass(topFile.path);
    writeBypassGranted = true;
  }

  if (branchBudget && lastVerificationCommand && branchBudget.wouldBlockCommandRetry(lastVerificationCommand)) {
    branchBudget.grantCommandRetryBypass(lastVerificationCommand);
    commandBypassGranted = true;
  }

  return { writeBypassGranted, commandBypassGranted };
}

export function buildRebuildEscalationMessage(
  failureCount: number,
  ctx: RebuildEscalationContext,
  trigger: RebuildEscalationTrigger = 'consecutive_failures',
): string {
  const implPath = ctx.topFile?.path;
  const readTestTargets = ctx.failingTestPaths.length > 0
    ? ctx.failingTestPaths
    : ['(from last verification output — locate the FAIL / .test.ts path)'];

  const steps = [
    `1. \`read_file\` each failing test (do NOT modify anything under \`test/\`): ${readTestTargets.map(p => `\`${p}\``).join(', ')}`,
    implPath
      ? `2. \`read_file\` stuck implementation: \`${implPath}\``
      : '2. \`read_file\` the implementation file(s) those tests import.',
    implPath
      ? `3. \`write_file\` **complete replacement** for \`${implPath}\` (full file body — no patch / edit_file / search_replace on this path).`
      : '3. \`write_file\` **complete replacement** for the stuck implementation (full file body — no patch).',
    ctx.lastVerificationCommand
      ? `4. \`run_command\`: \`${ctx.lastVerificationCommand}\` — only after steps 1–3.`
      : '4. Re-run verification (e.g. `npm test`) — only after steps 1–3.',
  ];

  const platformActions: string[] = [];
  if (ctx.writeBypassGranted && implPath) {
    platformActions.push(`one \`write_file\` to \`${implPath}\` allowed despite BranchBudget file cap`);
  }
  if (ctx.commandBypassGranted && ctx.lastVerificationCommand) {
    const short = ctx.lastVerificationCommand.length > 100
      ? `${ctx.lastVerificationCommand.slice(0, 97)}...`
      : ctx.lastVerificationCommand;
    platformActions.push(`one retry of \`${short}\` allowed despite BranchBudget command cap`);
  }

  const header = trigger === 'segment_renewal_budget'
    ? `[System / Rebuild Escalation] Recovery budget segment exhausted (segment #${failureCount}). Platform continues automatically — mandatory strategy change:`
    : trigger === 'file_cap_verification_failed'
    ? `[System / Rebuild Escalation] Verification still failing after ${ctx.topFile?.count ?? 'multiple'} edits to the stuck implementation (BranchBudget file cap reached).`
    : `[System / Rebuild Escalation] ${failureCount} consecutive rounds of tool calls have all failed.`;

  const parts = [
    header,
    'Patch-based fixes have not worked. **Mandatory workflow for the NEXT round:**',
    '',
    ...steps,
    '',
    '**Forbidden until step 4 completes:**',
    '- `edit_file`, patch, or search_replace on the stuck implementation',
    '- Re-running verification without rewriting implementation first',
    '- Modifying anything under `test/`',
    '- Deleting files with shell `rm`',
  ];

  if (implPath && ctx.topFile) {
    parts.push('', `**Stuck implementation:** \`${implPath}\` (edited ${ctx.topFile.count} times).`);
  }

  if (readTestTargets[0] !== '(from last verification output — locate the FAIL / .test.ts path)') {
    parts.push('', '**Failing tests (read first):**', ...readTestTargets.map(p => `- \`${p}\``));
  }

  if (ctx.verificationDigest) {
    parts.push('', '**Last verification evidence:**', ctx.verificationDigest);
  }

  if (ctx.recentFailureSnippets.length > 0) {
    parts.push('', '**Recent tool failures:**');
    ctx.recentFailureSnippets.forEach((s, i) => {
      parts.push(`${i + 1}. ${s.replace(/\s+/g, ' ').slice(0, 240)}`);
    });
  }

  if (platformActions.length > 0) {
    parts.push('', `**Platform:** ${platformActions.join('; ')}.`);
  }

  return parts.join('\n');
}
