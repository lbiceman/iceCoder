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

/** 透传后续命令的前缀程序，及其带参数的选项。 */
const COMMAND_WRAPPERS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C']),
  doas: new Set(['-u']),
  command: new Set(),
  exec: new Set(),
  builtin: new Set(),
  nohup: new Set(),
  time: new Set(),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k']),
  xargs: new Set(['-I', '-n', '-L', '-P', '-d', '-s', '-E']),
  npx: new Set(['-p', '--package']),
  pnpx: new Set(),
  bunx: new Set(),
  wsl: new Set(['-d', '--distribution', '-u', '--user', '--cd']),
  call: new Set(),
  start: new Set(),
};

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const EVAL_COMMANDS = new Set(['eval', 'iex', 'invoke-expression']);
const POWERSHELL_OPTIONS_WITH_VALUE = new Set([
  'executionpolicy', 'ex', 'ep',
  'windowstyle', 'w',
  'workingdirectory', 'wd',
  'configurationname', 'config',
  'outputformat', 'of', 'o',
  'inputformat', 'if', 'inp',
  'psconsolefile', 'version', 'v',
  'settingsfile', 'custompipename',
]);

const MAX_SHELL_NESTING = 6;

interface ShellWord {
  value: string;
  /** 在所属片段中的原始起始下标 */
  start: number;
  quoted: boolean;
}

function findClosingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * 按引号外的 `&& || ; | &`、换行、括号、反引号切成片段；
 * 双引号内的 `$(...)` / 反引号子命令会被执行，单独收进 nested。
 */
function splitShellSegments(command: string): { segments: string[]; nested: string[] } {
  const segments: string[] = [];
  const nested: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const flush = () => {
    segments.push(current);
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i++;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        const close = findClosingParen(command, i + 1);
        if (close > 0) {
          nested.push(command.slice(i + 2, close));
          i = close;
          continue;
        }
      }
      if (ch === '`') {
        const close = command.indexOf('`', i + 1);
        if (close > 0) {
          nested.push(command.slice(i + 1, close));
          i = close;
          continue;
        }
      }
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (';|&\n\r(){}`'.includes(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return { segments, nested };
}

function tokenizeSegment(segment: string): ShellWord[] {
  const words: ShellWord[] = [];
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i]!)) i++;
    if (i >= segment.length) break;
    const start = i;
    let value = '';
    let quoted = false;
    while (i < segment.length && !/\s/.test(segment[i]!)) {
      const ch = segment[i]!;
      if (ch !== '"' && ch !== "'") {
        value += ch;
        i++;
        continue;
      }
      quoted = true;
      i++;
      while (i < segment.length && segment[i] !== ch) {
        if (ch === '"' && segment[i] === '\\' && '"\\$`'.includes(segment[i + 1] ?? '')) {
          value += segment[i + 1];
          i += 2;
          continue;
        }
        value += segment[i];
        i++;
      }
      i++;
    }
    words.push({ value, start, quoted });
  }
  return words;
}

function executableName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** `-EncodedCommand` 的参数是 UTF-16LE 文本的 base64。 */
function decodePowerShellEncoded(value: string): string {
  return Buffer.from(value, 'base64').toString('utf16le');
}

function collectGitSubcommands(command: string, depth: number, out: string[]): void {
  if (depth > MAX_SHELL_NESTING) return;
  const { segments, nested } = splitShellSegments(command);
  for (const inner of nested) collectGitSubcommands(inner, depth + 1, out);
  for (const segment of segments) collectFromSegment(segment, depth, out);
}

function collectFromSegment(segment: string, depth: number, out: string[]): void {
  const words = tokenizeSegment(segment);
  /** 从第 k 个词起的剩余命令文本：仅一个词时取去引号后的值，否则保留原文交给下一层切分。 */
  const rest = (k: number): string => {
    if (k >= words.length) return '';
    return k === words.length - 1 ? words[k]!.value : segment.slice(words[k]!.start);
  };
  const recurse = (text: string) => {
    if (text.trim()) collectGitSubcommands(text, depth + 1, out);
  };

  let i = 0;
  for (;;) {
    while (i < words.length && isEnvAssignment(words[i]!.value)) i++;
    const wrapperOptions = words[i] ? COMMAND_WRAPPERS[executableName(words[i]!.value)] : undefined;
    if (!wrapperOptions) break;
    i++;
    while (i < words.length) {
      const w = words[i]!.value;
      if (w === '' || w.startsWith('-') || (w.startsWith('/') && w.length <= 3)) {
        i += wrapperOptions.has(w) ? 2 : 1;
      } else if (isEnvAssignment(w)) {
        i++;
      } else {
        break;
      }
    }
  }

  const head = words[i];
  if (!head) return;
  if (i === words.length - 1 && head.quoted && /\s/.test(head.value)) {
    recurse(head.value);
    return;
  }
  const exe = executableName(head.value);

  if (exe === 'git') {
    let j = i + 1;
    while (j < words.length && words[j]!.value.startsWith('-')) {
      j += GIT_OPTIONS_WITH_VALUE.has(words[j]!.value) ? 2 : 1;
    }
    const sub = words[j]?.value.toLowerCase();
    if (sub) out.push(sub);
    return;
  }

  if (POSIX_SHELLS.has(exe)) {
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j]!.value;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) {
        recurse(words[j + 1]?.value ?? '');
        return;
      }
      if (w === '-o' || w === '+o') {
        j++;
        continue;
      }
      if (!w.startsWith('-') && !w.startsWith('+')) return;
    }
    return;
  }

  if (POWERSHELLS.has(exe)) {
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j]!.value;
      if (!w.startsWith('-') && !w.startsWith('/')) {
        recurse(rest(j));
        return;
      }
      const name = w.slice(1).toLowerCase();
      if (name === 'commandwithargs' || name === 'cwa' || (name.length > 0 && 'command'.startsWith(name))) {
        recurse(rest(j + 1));
        return;
      }
      if (name === 'e' || name === 'ec' || (name.length >= 3 && 'encodedcommand'.startsWith(name))) {
        recurse(decodePowerShellEncoded(words[j + 1]?.value ?? ''));
        return;
      }
      if (name === 'f' || name === 'file') return;
      if (POWERSHELL_OPTIONS_WITH_VALUE.has(name)) j++;
    }
    return;
  }

  if (exe === 'cmd') {
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j]!.value;
      const m = /^\/[ck](.*)$/i.exec(w);
      if (m) {
        const inline = m[1] ?? '';
        recurse(inline ? [inline, rest(j + 1)].filter(Boolean).join(' ') : rest(j + 1));
        return;
      }
      if (!w.startsWith('/')) return;
    }
    return;
  }

  if (EVAL_COMMANDS.has(exe)) {
    const next = words[i + 1]?.value.toLowerCase() ?? '';
    recurse(rest(next.startsWith('-c') ? i + 2 : i + 1));
  }
}

function gitSubcommandsInCommand(command: string): string[] {
  const out: string[] = [];
  collectGitSubcommands(command, 0, out);
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
