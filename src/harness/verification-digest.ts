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

/** Playwright / 通用 `\d+ passed` 风格的 e2e 命令判定。 */
function isPlaywrightOrE2ECommand(command: string): boolean {
  const c = command.toLowerCase();
  return /\b(playwright|cypress)\b/.test(c)
    || /\bnpm\s+run\s+test:e2e\b/.test(c)
    || /\b(pnpm|yarn)\s+(run\s+)?test:e2e\b/.test(c);
}

/**
 * 从 vitest 输出中提取成功摘要。
 * 典型输出：
 *   Test Files  8 passed (8)
 *   Tests       22 passed (22)
 * 返回 `8 files / 22 tests passed`，失败时返回 null（让调用方走 failure digest）。
 */
export function parseVitestSuccessSummary(output: string): string | null {
  const body = output.trim();
  if (!body) return null;
  if (/\b(\d+\s+failed|FAIL\b|AssertionError)/i.test(body)) return null;

  const filesMatch = body.match(/Test Files\s+(\d+)\s+passed\s*\((\d+)\)/i);
  const testsMatch = body.match(/Tests\s+(\d+)\s+passed\s*\((\d+)\)/i);
  if (!testsMatch) return null;

  const tests = testsMatch[1];
  if (filesMatch) {
    return `${filesMatch[1]} files / ${tests} tests passed`;
  }
  return `${tests} tests passed`;
}

/**
 * 从 Playwright / e2e 输出中提取成功摘要。
 * 典型输出：`5 passed (4.4s)`、`Running 5 tests using 1 worker` + `5 passed`。
 */
export function parsePlaywrightSuccessSummary(output: string): string | null {
  const body = output.trim();
  if (!body) return null;
  if (/\b(failed|timed out|Test timeout)\b/i.test(body) && !/\b0 failed\b/i.test(body)) {
    return null;
  }
  const match = body.match(/(\d+)\s+passed\s*(?:\(([^)]+)\))?/i);
  if (!match) return null;
  const passed = match[1];
  const duration = match[2] ? ` in ${match[2]}` : '';
  return `${passed} e2e tests passed${duration}`;
}

/**
 * 从 vite / tsc 构建输出中提取成功摘要。
 * 典型：`✓ built in 7.49s` / `built in 7.49s`。
 */
export function parseBuildSuccessSummary(output: string): string | null {
  const body = output.trim();
  if (!body) return null;
  if (/\b(error TS\d+|RollupError|Build failed|ERROR\b)/i.test(body)) return null;

  const match = body.match(/built in\s+([0-9.]+\s*[a-z]+)/i);
  if (match) return `build succeeded in ${match[1]}`;
  if (/^\s*$/.test(body) || /Compiled successfully/i.test(body)) {
    return 'build succeeded';
  }
  return null;
}

/**
 * 从 `npm ci` / `npm install` 输出中提取成功摘要。
 */
export function parseNpmInstallSuccessSummary(output: string): string | null {
  const body = output.trim();
  if (!body) return null;
  if (/\b(npm ERR!|EACCES|EBUSY)\b/i.test(body)) return null;
  const match = body.match(/added\s+(\d+)\s+packages?(?:\s+in\s+([0-9.]+\s*[a-z]+))?/i);
  if (!match) return null;
  const duration = match[2] ? ` in ${match[2]}` : '';
  return `added ${match[1]} packages${duration}`;
}

/**
 * 构造验收命令「成功摘要」字符串（一行，几十字节）。
 *
 * 对**非失败**输出尽力解析；解析不出来时返回 `ok`，调用方仍可据此知道命令已成功。
 * 返回 null 表示这不是 harness 关心的验收命令（不打扰）。
 */
export function buildVerificationSuccessSummary(command: string, output: string): string | null {
  if (!isHarnessVerificationCommand(command) && !isPlaywrightOrE2ECommand(command)) {
    if (!/\bnpm\s+(ci|install)\b/i.test(command)) return null;
  }

  const cmdLower = command.toLowerCase();
  if (isBuildVerificationCommand(command)) {
    return parseBuildSuccessSummary(output) ?? 'build succeeded';
  }
  if (isPlaywrightOrE2ECommand(command)) {
    return parsePlaywrightSuccessSummary(output) ?? 'e2e passed';
  }
  if (/\b(npm\s+test|npm\s+run\s+test|vitest|jest|mocha)\b/i.test(cmdLower)) {
    return parseVitestSuccessSummary(output) ?? 'tests passed';
  }
  if (/\bnpm\s+(ci|install)\b/i.test(cmdLower)) {
    return parseNpmInstallSuccessSummary(output) ?? 'install ok';
  }
  return 'ok';
}

function safeParseToolOutputJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 从 run_command 工具原始 output 解析成功摘要。
 *
 * - `action:check` 的 rawOutput 是 JSON：优先用其中的 `summary`，否则从 `output` 字段再解析
 * - 前台命令 rawOutput 即 stdout，直接走 {@link buildVerificationSuccessSummary}
 */
export function resolveVerificationSuccessSummary(
  command: string,
  rawOutput: string,
  toolArgs?: Record<string, unknown> | null,
): string | null {
  const action = typeof toolArgs?.action === 'string' ? toolArgs.action.trim() : '';
  if (action === 'check') {
    const parsed = safeParseToolOutputJson(rawOutput);
    if (parsed) {
      const embedded = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      if (embedded) return embedded;
      const nestedOutput = typeof parsed.output === 'string' ? parsed.output : '';
      return buildVerificationSuccessSummary(command, nestedOutput);
    }
  }
  return buildVerificationSuccessSummary(command, rawOutput);
}
