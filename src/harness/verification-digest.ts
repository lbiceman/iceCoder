const VERIFICATION_CMD = /\b(npm\s+test|npm\s+run\s+test|vitest|npx\s+vitest)\b/i;

export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_CMD.test(command.trim());
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

export function buildVerificationDigest(command: string, output: string): string | null {
  if (!isVerificationCommand(command)) return null;
  const digest = parseVitestFailureDigest(output);
  if (!digest) return null;

  const shortCmd = command.length > 160 ? `${command.slice(0, 157)}...` : command;
  return [
    digest,
    '',
    `Command: ${shortCmd}`,
    'Next: read_file the failing test and implementation; do not rewrite the same file without new evidence.',
  ].join('\n');
}
