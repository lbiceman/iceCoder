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

/**
 * 仅用于没有参数、也不是脚本路径的孤立 runner。
 * 带参数的命令仍按结构宽松判断，避免把自定义 runner/包装器误杀。
 */
const ISOLATED_BARE_RUNNERS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'node', 'nodejs', 'tsx', 'ts-node',
  'cargo', 'go', 'python', 'python3', 'py', 'pytest', 'pip', 'pip3', 'poetry', 'uv',
  'make', 'cmake', 'mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet',
  'docker', 'docker-compose', 'podman',
  'just', 'task', 'bazel', 'turbo', 'nx', 'lerna',
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
  if (/\s=\s/.test(text)) return false;
  if (/^(?:\d+(?:\.\d+)?%?|\d+(?:ms|s|m|h|d)|--?[\w-]+)$/i.test(text)) return false;
  return text
    .split(/\s*(?:&&|\|\||;)\s*/)
    .filter(Boolean)
    .every(looksLikeRunnableSegment);
}

/**
 * 旧 TaskAcceptanceTracker 的过渡扫描策略。
 * 带参数命令沿用宽松合理性判定；孤立裸词仍须属于历史 runner 集合。
 */
export function looksLikeStrictTrackedCommand(value: string): boolean {
  const text = value.trim();
  if (!looksLikeRunnableCommand(text)) return false;
  if (/\s/.test(text) || /(?:&&|\|\||;)/.test(text)) return true;
  if (/[\\/]/.test(text) || isExecutableScriptPath(text)) return true;
  return isKnownIsolatedRunner(text);
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

function looksLikeRunnableSegment(segment: string): boolean {
  const text = segment.trim();
  if (!text) return false;
  if (/^(["']).*\1$/.test(text)) return false;
  if (!/\s/.test(text) && looksLikeBareFileOrGlob(text)) {
    return isExecutableScriptPath(text);
  }

  const tokens = commandTokens(text);
  const hasFlagSignal = tokens.slice(1).some(token => /^-{1,2}\S+/.test(token));
  const proseCandidate = text.replace(/"[^"]*"|'[^']*'/g, ' ');
  if (!hasFlagSignal && looksLikeObviousProse(proseCandidate)) return false;
  while (tokens.length > 1 && isEnvironmentAssignment(tokens[0]!)) {
    tokens.shift();
  }
  if (tokens.length === 0) return false;
  const head = tokens[0]!;
  if (tokens.length === 1 && /[a-z][A-Z]/.test(head)) return false;
  if (tokens.length === 1 && /^(?:build|test|lint|check|verify|run)$/i.test(head)) {
    return false;
  }
  if (looksLikeBareFileOrGlob(head)) {
    if (isExecutableScriptPath(head)) return true;
    if (isRejectedArtifactPath(head)) return false;
    return tokens.length > 1 && !/[*?]|[\\/]$/.test(head);
  }
  if (tokens.length === 1) return isKnownIsolatedRunner(head);
  return true;
}

function isKnownIsolatedRunner(value: string): boolean {
  const executable = value.replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase();
  return ISOLATED_BARE_RUNNERS.has(executable);
}

function looksLikeObviousProse(text: string): boolean {
  const words = text.split(/\s+/);
  return (
    words.length >= 4
      && /^(?:the|a|an|this|that|please|just|we|you|i|read|explain|describe|mention)\b/i
        .test(text)
  ) || (
    words.length >= 3
      && /\b(?:of|the|is|are|to|for|with|here|mentions?)\b/i.test(text)
  );
}

function commandTokens(text: string): string[] {
  return Array.from(text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), match =>
    (match[1] ?? match[2] ?? match[3] ?? '').trim(),
  ).filter(Boolean);
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(token);
}

function isExecutableScriptPath(value: string): boolean {
  const unquoted = value.replace(/^(['"])(.*)\1$/, '$2');
  if (/[*?]|\.\.$/.test(unquoted) || /[\\/]$/.test(unquoted)) return false;
  return /\.(?:exe|cmd|bat|ps1|sh)$/i.test(unquoted)
    || /^(?:\.{1,2}[\\/]|bin[\\/])[^\\/]+$/i.test(unquoted);
}

function isRejectedArtifactPath(value: string): boolean {
  return /\.(?:md|json|ya?ml|toml|lock|txt|ts|tsx|js|mjs|cjs|jsx|css|html|map)$/i
    .test(value);
}

function firstCommandToken(text: string): string {
  const match = text.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/(?:^|\r?\n)([{\[])/g)) {
    const start = match.index + match[0].length - 1;
    if (start > 0) candidates.push(trimmed.slice(start));
  }
  for (const candidate of candidates) {
    if (candidate[0] !== '{' && candidate[0] !== '[') continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 尝试 Harness 错误前缀后的下一段 JSON。
    }
  }
  return null;
}
