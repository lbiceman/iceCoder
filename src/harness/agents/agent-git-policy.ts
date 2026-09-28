/**
 * 子 Agent 禁止执行会改写仓库历史 / 工作区整体状态的 git 操作。
 * 这些操作影响的是整个仓库，并行子 Agent 彼此看不见对方，交给主 Agent 统一处理。
 */

import type { ToolCall } from '../../llm/types.js';

const BLOCKED_GIT_SUBCOMMANDS = new Set([
  'commit',
  'push',
  'reset',
  'checkout',
  'switch',
  'stash',
  'rebase',
  'merge',
  'clean',
  'pull',
  'cherry-pick',
  'restore',
  'revert',
]);

/** git 全局选项里带参数的那几个（`git -C dir commit`）。 */
const GIT_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace']);

function gitSubcommandsInCommand(command: string): string[] {
  const out: string[] = [];
  const segments = command.split(/&&|\|\||;|\||\r?\n/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    const exe = (tokens[i] ?? '').replace(/^["']|["']$/g, '');
    const base = exe.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
    if (base !== 'git') continue;
    i++;
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      const opt = tokens[i]!;
      i += GIT_OPTIONS_WITH_VALUE.has(opt) ? 2 : 1;
    }
    const sub = tokens[i]?.toLowerCase();
    if (sub) out.push(sub);
  }
  return out;
}

/** 命中禁止项时返回被拦截的子命令。 */
export function findBlockedSubAgentGitSubcommand(toolCall: ToolCall): string | null {
  const args = toolCall.arguments ?? {};
  if (toolCall.name === 'git') {
    const sub = String(args.subcommand ?? '').trim().toLowerCase();
    return BLOCKED_GIT_SUBCOMMANDS.has(sub) ? sub : null;
  }
  if (toolCall.name === 'run_command' || toolCall.name === 'shell_exec') {
    const command = typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string' ? args.cmd : '';
    if (!command) return null;
    return gitSubcommandsInCommand(command).find(sub => BLOCKED_GIT_SUBCOMMANDS.has(sub)) ?? null;
  }
  return null;
}

export function formatSubAgentGitBlockMessage(subcommand: string): string {
  return [
    `[Harness / Sub-Agent] \`git ${subcommand}\` is not allowed inside a sub-agent.`,
    'Sub-agents must not commit, push, reset, switch branches, stash, rebase, merge or clean.',
    'Leave the working tree as is and mention anything that needs a git operation in your final report.',
  ].join('\n');
}
