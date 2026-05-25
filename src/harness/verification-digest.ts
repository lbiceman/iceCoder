const VERIFICATION_TEST_CMD = /\b(npm\s+test|npm\s+run\s+test|vitest|npx\s+vitest)\b/i;

/** 与 TaskState.looksLikeVerificationCommand 对齐的 harness 验收命令判定。 */
export function isHarnessVerificationCommand(command: string): boolean {
  const c = command.toLowerCase();
  return /\b(npm|pnpm|yarn)\s+(run\s+)?(test:e2e|test|lint|build|typecheck|check)\b/.test(c)
    || /\b(npm|pnpm|yarn)\s+test\b/.test(c)
    || /\b(vitest|jest|mocha|pytest|go test|cargo test)\b/.test(c)
    || /\b(npx\s+vitest|npx\s+tsc|tsc\s+--no-?emit)\b/i.test(command)
    || /\bnode\s+--check\b/.test(c);
}

/** @deprecated 使用 {@link isHarnessVerificationCommand} */
export function isVerificationCommand(command: string): boolean {
  return isHarnessVerificationCommand(command.trim());
}

export function isBuildVerificationCommand(command: string): boolean {
  const c = command.toLowerCase();
  return /\bnpm\s+run\s+build\b/.test(c)
    || /\bnpx\s+tsc\b/.test(c)
    || /\btsc\s+--no-emit\b/.test(c)
    || /\bvite\s+build\b/.test(c)
    || /\bnode\s+.*vite.*build\b/.test(c);
}

export function isTestVerificationCommand(command: string): boolean {
  return VERIFICATION_TEST_CMD.test(command.trim());
}

/**
 * 从 vitest / npm test 输出中提取简短失败摘要，供验收失败时注入模型上下文。
 */
export function parseVitestFailureDigest(output: string): string | null {
  const body = output.trim();
  if (!body) return null;

  const lines = body.split(/\r?\n/);
  const failHeaders: string[] = [];
  const assertions: string[] = [];
  const hints: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^FAIL\b/i.test(trimmed) || /^❯\s/.test(trimmed)) {
      failHeaders.push(trimmed.slice(0, 200));
      continue;
    }

    if (/AssertionError|Expected|expected.*to/i.test(trimmed)) {
      assertions.push(trimmed.slice(0, 240));
      continue;
    }

    if (/\.test\.(ts|tsx|js|jsx)/i.test(trimmed) && /failed|error/i.test(trimmed)) {
      hints.push(trimmed.slice(0, 200));
    }
  }

  if (failHeaders.length === 0 && assertions.length === 0 && hints.length === 0) {
    const compact = body.replace(/\s+/g, ' ').slice(0, 600);
    return compact.length > 20 ? compact : null;
  }

  const parts: string[] = ['[Verification digest]'];
  if (failHeaders.length > 0) {
    parts.push('Failed suites / cases:');
    parts.push(...failHeaders.slice(0, 4).map(l => `- ${l}`));
  }
  if (assertions.length > 0) {
    parts.push('Assertions:');
    parts.push(...assertions.slice(0, 4).map(l => `- ${l}`));
  }
  if (hints.length > 0) {
    parts.push('Related:');
    parts.push(...hints.slice(0, 2).map(l => `- ${l}`));
  }

  return parts.join('\n');
}

/** 从 tsc / vite / rollup 输出中提取 build 失败摘要。 */
export function parseBuildFailureDigest(output: string): string | null {
  const body = output.trim();
  if (!body) return null;

  const lines = body.split(/\r?\n/);
  const errors: string[] = [];
  const hints: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/error TS\d+:/i.test(trimmed)
      || /^ERROR\b/i.test(trimmed)
      || /\[vite\].*error/i.test(trimmed)
      || /RollupError|Failed to compile|Build failed/i.test(trimmed)
      || /Cannot find module/i.test(trimmed)) {
      errors.push(trimmed.slice(0, 260));
      continue;
    }

    if (/\.(ts|tsx|js|jsx)\(\d+,\d+\)/i.test(trimmed)) {
      hints.push(trimmed.slice(0, 220));
    }
  }

  if (errors.length === 0 && hints.length === 0) {
    const compact = body.replace(/\s+/g, ' ').slice(0, 600);
    return compact.length > 20 ? `[Build digest]\n${compact}` : null;
  }

  const parts: string[] = ['[Build digest]'];
  if (errors.length > 0) {
    parts.push('Errors:');
    parts.push(...errors.slice(0, 6).map(l => `- ${l}`));
  }
  if (hints.length > 0) {
    parts.push('Locations:');
    parts.push(...hints.slice(0, 4).map(l => `- ${l}`));
  }
  return parts.join('\n');
}

/** 从 build 输出中提取疑似源文件路径。 */
export function parseBuildErrorSourcePaths(output: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /(?:^|\s)(src\/[^\s(]+\.(?:ts|tsx|js|jsx))/gi,
    /(?:^|\s)([^\s(]+\.(?:ts|tsx))(?:\(\d+,\d+\))/gi,
    /error TS\d+:.*?\(([^)]+\.(?:ts|tsx))\)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(output)) !== null) {
      const p = match[1]?.replace(/^[('"]+|[)'"]+$/g, '');
      if (p && !p.includes('node_modules')) paths.add(p);
    }
  }
  return [...paths].slice(0, 4);
}

export function buildVerificationDigest(command: string, output: string): string | null {
  if (!isHarnessVerificationCommand(command)) return null;

  const digest = isBuildVerificationCommand(command)
    ? parseBuildFailureDigest(output)
    : parseVitestFailureDigest(output);
  if (!digest) return null;

  const shortCmd = command.length > 160 ? `${command.slice(0, 157)}...` : command;
  const nextStep = isBuildVerificationCommand(command)
    ? 'Next: read_file the reported source files; run npx tsc --noEmit if needed; fix TypeScript before rerunning build.'
    : 'Next: read_file the failing test and implementation; do not rewrite the same file without new evidence.';

  return [
    digest,
    '',
    `Command: ${shortCmd}`,
    nextStep,
  ].join('\n');
}
