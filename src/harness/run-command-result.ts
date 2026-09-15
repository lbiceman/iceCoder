/**
 * `run_command` 工具结果的统一分类。
 *
 * 后台启动成功不等于命令执行成功；只有前台终态或后台 check 终态
 * 才能供验收、失败连续计数等下游使用。
 */
export type RunCommandResultClassification =
  | { kind: 'foreground'; command: string; foregroundSuccess: boolean; exitCode?: number }
  | { kind: 'background_start'; command: string }
  | { kind: 'background_running'; command: string }
  | { kind: 'background_completed'; command: string; exitCode?: number }
  | { kind: 'background_failed'; command: string; exitCode?: number; statusLabel?: string };

const COMMAND_RUNNERS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'node', 'nodejs', 'tsx', 'ts-node',
  'cargo', 'go', 'python', 'python3', 'py', 'pytest', 'pip', 'pip3', 'poetry', 'uv',
  'make', 'cmake', 'mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet',
  'docker', 'docker-compose', 'podman',
  'just', 'task', 'bazel',
  'vitest', 'jest', 'mocha', 'playwright', 'cypress',
  'pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh',
  'php', 'composer', 'ruby', 'java', 'rake', 'bundle',
]);

export function classifyRunCommandResult(
  args: Record<string, unknown> | undefined | null,
  rawOutput: string,
  toolSuccess: boolean,
): RunCommandResultClassification | null {
  const normalizedArgs = args ?? {};
  const action = typeof normalizedArgs.action === 'string'
    ? normalizedArgs.action.trim()
    : '';
  const argumentCommand = typeof normalizedArgs.command === 'string'
    ? normalizedArgs.command
    : typeof normalizedArgs.cmd === 'string'
      ? normalizedArgs.cmd
      : '';

  if (action === 'check' || action === 'list' || action === 'stop') {
    const parsed = safeParseJson(rawOutput);
    if (!parsed) return null;
    const label = typeof parsed.label === 'string' ? parsed.label : '';
    const responseCommand = typeof parsed.command === 'string' && parsed.command.trim()
      ? parsed.command.trim()
      : label;
    const status = typeof parsed.status === 'string' ? parsed.status : '';
    const exitCode = typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined;
    if (!responseCommand) return null;
    if (status === 'completed') {
      return exitCode !== undefined && exitCode !== 0
        ? {
            kind: 'background_failed',
            command: responseCommand,
            exitCode,
            statusLabel: 'completed_nonzero',
          }
        : { kind: 'background_completed', command: responseCommand, exitCode };
    }
    if (status === 'failed' || status === 'timeout' || status === 'killed') {
      return {
        kind: 'background_failed',
        command: responseCommand,
        exitCode,
        statusLabel: status,
      };
    }
    if (status === 'running') {
      return { kind: 'background_running', command: responseCommand };
    }
    return null;
  }

  if (!argumentCommand.trim()) return null;
  if (toolSuccess) {
    const parsed = safeParseJson(rawOutput);
    if (parsed) {
      const mode = typeof parsed.mode === 'string' ? parsed.mode : '';
      if (mode === 'background' || mode === 'escalated') {
        return { kind: 'background_start', command: argumentCommand };
      }
    }
  }
  return {
    kind: 'foreground',
    command: argumentCommand,
    foregroundSuccess: toolSuccess,
  };
}

/**
 * 剥离 Windows / POSIX 常见的 `cd ... && <real-cmd>` 前缀，仅保留真实命令体。
 */
export function stripLeadingCdPrefix(command: string): string {
  const match = command.trim().match(
    /^cd\s+(?:\/d\s+)?(?:"[^"]+"|'[^']+'|[^\s&|;]+)\s*&&\s*(.+)$/i,
  );
  return match && match[1].trim() ? match[1].trim() : command.trim();
}

/**
 * 命令归一化键：剥离 cwd 前缀、输出噪声和平台可执行后缀，
 * 同时保留用户命令本身的身份，不做框架别名转换。
 */
export function normalizeAcceptanceCommandKey(command: string): string {
  let key = stripLeadingCdPrefix(command);

  key = key
    .replace(/\s+/g, ' ')
    .replace(/\s2>&1\s*$/i, '')
    .replace(/\s\|\s*(head|tail|less|more|grep)\b[^|]*$/i, '')
    .replace(/\s>\s*\S+(?:\s+2>&1)?\s*$/i, '')
    .trim()
    .toLowerCase();

  return normalizeExecutableIdentity(key);
}

/** 文件路径、公式和自然语言不是可执行验收命令。 */
export function looksLikeRunnableCommand(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 500 || /[\r\n\u0000]/.test(text)) return false;
  if (/^(?:the|a|an|this|that|please|just)\b/i.test(text) && text.split(/\s+/).length > 8) {
    return false;
  }
  if (/=/.test(text) && !/^[A-Za-z_][\w.-]*=\S+\s+\S/.test(text)) return false;
  if (/^(?:\.\/|\.\\)/.test(text)) return true;
  if (looksLikeBareFileOrGlob(text)) return false;
  const head = firstCommandToken(text);
  if (!head) return false;
  const executable = head
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(?:exe|cmd|bat|com)$/i, '') ?? head;
  return COMMAND_RUNNERS.has(executable.toLowerCase());
}

function normalizeExecutableIdentity(command: string): string {
  const match = command.match(/^(?:"([^"]+)"|(\S+))(.*)$/);
  if (!match) return command;
  const executable = match[1] ?? match[2] ?? '';
  const suffix = match[3] ?? '';
  const basename = executable
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(?:exe|cmd|bat|com)$/i, '');
  return basename ? `${basename}${suffix}`.trim() : command;
}

function looksLikeBareFileOrGlob(text: string): boolean {
  if (/\s/.test(text)) return false;
  if (/\/$|\*\*?$/.test(text)) return true;
  if (/[\\/]/.test(text)) return true;
  return /\.(md|json|ya?ml|toml|lock|txt|ts|tsx|js|mjs|cjs|jsx|css|html|map)$/i.test(text);
}

function firstCommandToken(text: string): string {
  const match = text.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
