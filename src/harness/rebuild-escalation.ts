import type { UnifiedMessage, ToolCall } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import { MAX_REBUILD_ESCALATIONS_PER_RUN } from './harness-constants.js';
import { extractRunCommand } from './branch-budget-tool-path.js';
import { topFileEditFromInspect } from './supervisor/passive-observer.js';
import type { VerificationOutputBuffer } from './verification-output-buffer.js';
import { buildVerificationDigest, isBuildVerificationCommand, isHarnessVerificationCommand, parseBuildErrorSourcePaths } from './verification-digest.js';
import { workspaceFileExists } from './workspace-path-guard.js';

export type RebuildEscalationTrigger =
  | 'consecutive_failures'
  | 'file_cap_verification_failed'
  | 'segment_renewal_budget'
  | 'missing_file_budget_mismatch';

export interface RebuildEscalationContext {
  topFile?: { path: string; count: number };
  failingTestPaths: string[];
  verificationDigest: string | null;
  lastVerificationCommand: string | null;
  recentFailureSnippets: string[];
  writeBypassGranted: boolean;
  /** 批量授予 write bypass 的路径（canonical） */
  writeBypassPaths: string[];
  commandBypassGranted: boolean;
  /** 卡点文件在 workspace 磁盘上不存在（Budget 计数与事实脱节）。 */
  fileMissingOnDisk?: boolean;
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
export function findLastFailedVerification(
  messages: UnifiedMessage[],
  buffer?: VerificationOutputBuffer,
): {
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
    if (!command || !isHarnessVerificationCommand(command)) continue;

    if (!commandOnly) commandOnly = command;

    const body = stripToolErrorPrefix(msg.content);
    if (body) {
      return { command, outputBody: body };
    }
  }

  const buffered = buffer?.findLastFailed(commandOnly);
  if (buffered) {
    return { command: buffered.command, outputBody: buffered.outputBody };
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
  buffer?: VerificationOutputBuffer,
): string {
  const verification = findLastFailedVerification(messages, buffer);
  if (!verification?.outputBody) return baseMessage;

  const digest = buildVerificationDigest(verification.command, verification.outputBody);
  if (!digest) return baseMessage;

  const paths = isBuildVerificationCommand(verification.command)
    ? parseBuildErrorSourcePaths(verification.outputBody)
    : parseFailingTestPaths(verification.outputBody);
  const parts = [baseMessage, '', '**Last verification evidence:**', digest];
  if (paths.length > 0) {
    const label = isBuildVerificationCommand(verification.command)
      ? 'Source files (read first)'
      : 'Failing tests (read first)';
    parts.push('', `**${label}:** ${paths.map(p => `\`${p}\``).join(', ')}`);
  }
  return parts.join('\n');
}

function rebuildEscalationBudgetExhausted(
  injections: number,
  maxPerRun = MAX_REBUILD_ESCALATIONS_PER_RUN,
): boolean {
  return injections >= maxPerRun;
}

/** P1：同轮 / 配额内是否允许注入 Rebuild Escalation。 */
export function canInjectRebuildEscalation(args: {
  rebuildEscalationInjections: number;
  rebuildEscalationInjectedThisRound: boolean;
  maxRebuildEscalationsPerRun?: number;
  suppressInject?: boolean;
}): boolean {
  if (args.suppressInject) return false;
  if (args.rebuildEscalationInjectedThisRound) return false;
  return !rebuildEscalationBudgetExhausted(
    args.rebuildEscalationInjections,
    args.maxRebuildEscalationsPerRun,
  );
}

/** P2：并行 BranchBudget 拦截指引是否应注入（每 run 一次）。 */
export function shouldInjectParallelBudgetBlockHint(args: {
  parallelBudgetBlockHintInjected: boolean;
  budgetBlockedFilePathCount: number;
  blockedWriteToolCount: number;
  suppressInject?: boolean;
}): boolean {
  if (args.suppressInject) return false;
  if (args.parallelBudgetBlockHintInjected) return false;
  return args.budgetBlockedFilePathCount >= 2 && args.blockedWriteToolCount >= 2;
}

/** 同一实现文件达 BranchBudget 上限且验收仍失败 → 触发 rebuild（不依赖连续全失败轮次）。 */
export function shouldTriggerFileCapRebuild(args: {
  branchBudget?: BranchBudgetTracker;
  verificationStatus: string;
  rebuildEscalationInjections: number;
  maxRebuildEscalationsPerRun?: number;
}): boolean {
  if (rebuildEscalationBudgetExhausted(
    args.rebuildEscalationInjections,
    args.maxRebuildEscalationsPerRun,
  ) || !args.branchBudget) return false;
  if (args.verificationStatus !== 'failed') return false;

  const topFile = topFileEditFromInspect(args.branchBudget.inspect().fileEdits);
  if (!topFile) return false;
  return args.branchBudget.wouldBlockFileEdit(topFile.path);
}

/** Budget 已满但磁盘无文件 → 触发 rebuild + write bypass（不依赖 verificationStatus）。 */
export function shouldTriggerMissingFileBudgetRebuild(args: {
  branchBudget?: BranchBudgetTracker;
  workspaceRoot?: string;
  rebuildEscalationInjections: number;
  maxRebuildEscalationsPerRun?: number;
}): boolean {
  if (
    rebuildEscalationBudgetExhausted(
      args.rebuildEscalationInjections,
      args.maxRebuildEscalationsPerRun,
    )
    || !args.branchBudget
    || !args.workspaceRoot
  ) return false;

  const topFile = topFileEditFromInspect(args.branchBudget.inspect().fileEdits);
  if (!topFile) return false;
  if (!args.branchBudget.wouldBlockFileEdit(topFile.path)) return false;
  return !workspaceFileExists(args.workspaceRoot, topFile.path);
}

export function shouldTriggerAnyFileCapRebuild(args: {
  branchBudget?: BranchBudgetTracker;
  verificationStatus: string;
  workspaceRoot?: string;
  rebuildEscalationInjections: number;
  maxRebuildEscalationsPerRun?: number;
}): { trigger: RebuildEscalationTrigger; topFile?: { path: string; count: number } } | null {
  if (
    rebuildEscalationBudgetExhausted(
      args.rebuildEscalationInjections,
      args.maxRebuildEscalationsPerRun,
    )
    || !args.branchBudget
  ) return null;

  const topFile = topFileEditFromInspect(args.branchBudget.inspect().fileEdits);
  if (!topFile || !args.branchBudget.wouldBlockFileEdit(topFile.path)) return null;

  if (
    args.workspaceRoot
    && !workspaceFileExists(args.workspaceRoot, topFile.path)
  ) {
    return { trigger: 'missing_file_budget_mismatch', topFile };
  }

  if (args.verificationStatus === 'failed') {
    return { trigger: 'file_cap_verification_failed', topFile };
  }

  return null;
}

/** 第 5 轮 escalation：收集验收证据、卡点文件与最近失败摘要。 */
export function collectRebuildEscalationContext(
  messages: UnifiedMessage[],
  topFile: { path: string; count: number } | undefined,
  buffer?: VerificationOutputBuffer,
  workspaceRoot?: string,
): Omit<RebuildEscalationContext, 'writeBypassGranted' | 'commandBypassGranted'> {
  const verification = findLastFailedVerification(messages, buffer);
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
    fileMissingOnDisk: workspaceRoot && topFile
      ? !workspaceFileExists(workspaceRoot, topFile.path)
      : undefined,
  };
}

const REBUILD_BYPASS_PATH_CAP = 4;

/** 从 Budget 计数与最近验收输出收集需 write bypass 的实现路径（不含 test/）。 */
export function collectRebuildBypassPaths(args: {
  branchBudget: BranchBudgetTracker;
  topFile?: { path: string; count: number };
  messages: UnifiedMessage[];
  buffer?: VerificationOutputBuffer;
  maxPaths?: number;
}): string[] {
  const max = args.maxPaths ?? REBUILD_BYPASS_PATH_CAP;
  const paths = new Set<string>();

  if (args.topFile && args.branchBudget.wouldBlockFileEdit(args.topFile.path)) {
    paths.add(args.topFile.path);
  }

  for (const p of Object.keys(args.branchBudget.inspect().fileEdits)) {
    if (args.branchBudget.wouldBlockFileEdit(p)) paths.add(p);
  }

  const verification = findLastFailedVerification(args.messages, args.buffer);
  if (verification?.outputBody) {
    const fromBuild = parseBuildErrorSourcePaths(verification.outputBody);
    const fromTests = parseFailingTestPaths(verification.outputBody);
    for (const p of [...fromBuild, ...fromTests]) {
      if (p.includes('.test.') || p.startsWith('test/')) continue;
      if (args.branchBudget.wouldBlockFileEdit(p)) paths.add(p);
    }
  }

  return [...paths].slice(0, max);
}

/** 授予 write / 验收命令重试豁免（验收失败时可批量 grant，默认最多 4 路径）。 */
export function applyRebuildEscalationBypasses(
  branchBudget: BranchBudgetTracker | undefined,
  topFile: { path: string; count: number } | undefined,
  lastVerificationCommand: string | null,
  messages?: UnifiedMessage[],
  buffer?: VerificationOutputBuffer,
  workspaceRoot?: string,
): Pick<RebuildEscalationContext, 'writeBypassGranted' | 'writeBypassPaths' | 'commandBypassGranted'> {
  let writeBypassPaths: string[] = [];
  let commandBypassGranted = false;

  if (branchBudget) {
    branchBudget.bindWorkspaceRoot(workspaceRoot);
    const candidates = messages
      ? collectRebuildBypassPaths({
        branchBudget,
        topFile,
        messages,
        buffer,
      })
      : topFile && branchBudget.wouldBlockFileEdit(topFile.path)
      ? [topFile.path]
      : [];
    writeBypassPaths = branchBudget.grantWriteBypassMany(candidates);
  }

  if (branchBudget && lastVerificationCommand && branchBudget.wouldBlockCommandRetry(lastVerificationCommand)) {
    branchBudget.grantCommandRetryBypass(lastVerificationCommand);
    commandBypassGranted = true;
  }

  return {
    writeBypassGranted: writeBypassPaths.length > 0,
    writeBypassPaths,
    commandBypassGranted,
  };
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

  const steps = ctx.fileMissingOnDisk && implPath
    ? [
      `1. \`run_command\` or \`read_file\` an **existing** file in the same directory as a template (do NOT \`read_file\` \`${implPath}\` — missing on disk).`,
      `2. \`write_file\` **create** \`${implPath}\` with the complete file body (no patch / edit_file).`,
      ctx.lastVerificationCommand
        ? `3. \`run_command\`: \`${ctx.lastVerificationCommand}\` — only after step 2.`
        : '3. Re-run verification (e.g. `npm test`) — only after step 2.',
    ]
    : [
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
  const bypassPaths = ctx.writeBypassPaths.length > 0
    ? ctx.writeBypassPaths
    : (ctx.writeBypassGranted && implPath ? [implPath] : []);
  if (bypassPaths.length === 1) {
    platformActions.push(`one \`write_file\` to \`${bypassPaths[0]}\` allowed despite BranchBudget file cap`);
  } else if (bypassPaths.length > 1) {
    platformActions.push(
      `one \`write_file\` each allowed despite BranchBudget file cap: ${bypassPaths.map(p => `\`${p}\``).join(', ')}`,
    );
  }
  if (ctx.commandBypassGranted && ctx.lastVerificationCommand) {
    const short = ctx.lastVerificationCommand.length > 100
      ? `${ctx.lastVerificationCommand.slice(0, 97)}...`
      : ctx.lastVerificationCommand;
    platformActions.push(`one retry of \`${short}\` allowed despite BranchBudget command cap`);
  }

  const header = trigger === 'segment_renewal_budget'
    ? `[System / Rebuild Escalation] Recovery budget segment exhausted (segment #${failureCount}). Platform continues automatically — mandatory strategy change:`
    : trigger === 'missing_file_budget_mismatch'
    ? `[System / Rebuild Escalation] BranchBudget file cap reached but \`${ctx.topFile?.path ?? 'implementation'}\` was never persisted on disk (edit count includes failed patches).`
    : trigger === 'file_cap_verification_failed'
    ? `[System / Rebuild Escalation] Verification still failing after ${ctx.topFile?.count ?? 'multiple'} edits to the stuck implementation (BranchBudget file cap reached).`
    : `[System / Rebuild Escalation] ${failureCount} consecutive rounds of tool calls have all failed.`;

  const forbiddenStep = ctx.fileMissingOnDisk ? '3' : '4';
  const parts = [
    header,
    'Patch-based fixes have not worked. **Mandatory workflow for the NEXT round:**',
    '',
    ...steps,
    '',
    `**Forbidden until step ${forbiddenStep} completes:**`,
    '- `edit_file`, patch, or search_replace on the stuck implementation',
    '- Re-running verification without rewriting implementation first',
    '- Modifying anything under `test/`',
    '- Deleting files with shell `rm`',
  ];

  if (ctx.fileMissingOnDisk && implPath) {
    parts.push('', `- Do NOT \`read_file\` missing path \`${implPath}\` — use \`write_file\` to create it.`);
  }

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
