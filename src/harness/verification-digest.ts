const OUTPUT_TAIL_CHARS = 1200;

export function takeCommandOutputTail(output: string, maxChars = OUTPUT_TAIL_CHARS): string {
  const body = output.replace(/^(?:工具执行错误|Tool execution error)[:：][^\n]*\n+/m, '').trim();
  if (!body) return '';
  return body.length <= maxChars ? body : body.slice(-maxChars);
}

export function buildVerificationDigest(command: string, output: string): string | null {
  const tail = takeCommandOutputTail(output);
  if (!tail) return null;
  const shortCmd = command.length > 160 ? `${command.slice(0, 157)}...` : command;
  return [
    '[Verification digest]',
    `Command: ${shortCmd}`,
    tail,
    '',
    'Next: inspect this round\'s output and re-run the project\'s own verification command after fixing the cause.',
  ].join('\n');
}

export function buildVerificationSuccessSummary(command: string, output: string): string | null {
  const tail = takeCommandOutputTail(output, 200);
  if (!tail) return 'ok';
  const firstLine = tail.split(/\r?\n/).find(l => l.trim()) ?? 'ok';
  return firstLine.slice(0, 120);
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
    /(?:^|\s)((?:\.\/)?[\w./\\-]+\.\w+)(?:\(\d+,\d+\))?/gi,
    /error TS\d+:.*?\(([^)]+)\)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(output)) !== null) {
      const p = match[1]?.replace(/^[('"]+|[)'"]+$/g, '');
      if (p && !p.includes('node_modules') && /[\\/]|\.\w+$/.test(p)) paths.add(p);
    }
  }
  return [...paths].slice(0, 4);
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
