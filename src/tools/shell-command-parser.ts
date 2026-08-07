/**
 * Quote-aware shell command expansion shared by sandbox and risk classification.
 *
 * This is intentionally a command-boundary parser rather than a complete shell
 * grammar. It keeps separators inside quotes intact and recursively unwraps the
 * command payload accepted by common shell launchers.
 */

export interface ShellCommandToken {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

function pushSegment(segments: string[], raw: string): void {
  const trimmed = raw.trim();
  if (trimmed) segments.push(trimmed);
}

/** Split newline, `;`, `&&`, `||`, and pipelines outside quotes. */
export function splitShellCommandSegments(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      pushSegment(segments, current);
      current = '';
      i++;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      pushSegment(segments, current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      pushSegment(segments, current);
      current = '';
      if (ch === '\r' && input[i + 1] === '\n') i++;
      continue;
    }

    current += ch;
  }

  pushSegment(segments, current);
  return segments;
}

/** Tokenize one command segment while retaining source ranges. */
export function tokenizeShellCommand(segment: string): ShellCommandToken[] {
  const tokens: ShellCommandToken[] = [];
  let i = 0;

  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i])) i++;
    if (i >= segment.length) break;

    const start = i;
    let value = '';
    let quote: '"' | "'" | null = null;
    let quoted = false;

    while (i < segment.length) {
      const ch = segment[i];
      if (!quote && /\s/.test(ch)) break;

      if (!quote && (ch === '"' || ch === "'")) {
        quote = ch;
        quoted = true;
        i++;
        continue;
      }
      if (quote && ch === quote) {
        quote = null;
        i++;
        continue;
      }
      if (ch === '\\' && quote !== "'") {
        const next = segment[i + 1];
        const escapable = quote === '"'
          ? next === '"' || next === '\\'
          : next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === '\\');
        if (next !== undefined && escapable) {
          value += next;
          i += 2;
          continue;
        }
        value += ch;
        i++;
        continue;
      }

      value += ch;
      i++;
    }

    tokens.push({ value, start, end: i, quoted });
  }

  return tokens;
}

function executableBasename(token: string): string {
  return token.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
}

function payloadFromToken(
  segment: string,
  tokens: ShellCommandToken[],
  index: number,
  consumeRest: boolean,
): string | null {
  const token = tokens[index];
  if (!token) return null;
  const payload = token.quoted || !consumeRest
    ? token.value
    : segment.slice(token.start).trim();
  return payload.trim() || null;
}

/** Extract direct `-c`/`/c`/`-Command` payloads found in one segment. */
export function extractNestedShellPayloads(segment: string): string[] {
  const tokens = tokenizeShellCommand(segment);
  const payloads: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const executable = executableBasename(tokens[i].value);

    if (/^(?:ba|z|da|k)?sh$/.test(executable)) {
      for (let j = i + 1; j < tokens.length; j++) {
        const option = tokens[j].value;
        if (/^-[^-]*c[^-]*$/i.test(option)) {
          const payload = payloadFromToken(segment, tokens, j + 1, false);
          if (payload) payloads.push(payload);
          break;
        }
        if (!option.startsWith('-')) break;
      }
      continue;
    }

    if (executable === 'cmd') {
      for (let j = i + 1; j < tokens.length; j++) {
        if (/^\/c$/i.test(tokens[j].value)) {
          const payload = payloadFromToken(segment, tokens, j + 1, true);
          if (payload) payloads.push(payload);
          break;
        }
        if (!tokens[j].value.startsWith('/')) break;
      }
      continue;
    }

    if (executable === 'powershell' || executable === 'pwsh') {
      for (let j = i + 1; j < tokens.length; j++) {
        if (/^-(?:command|c)$/i.test(tokens[j].value)) {
          const payload = payloadFromToken(segment, tokens, j + 1, true);
          if (payload) payloads.push(payload);
          break;
        }
        if (!tokens[j].value.startsWith('-')) break;
      }
    }
  }

  return payloads;
}

/** Expand compound and nested commands breadth-first, de-duplicated. */
export function collectExpandedShellCommands(command: string): string[] {
  const queue = splitShellCommandSegments(command);
  const seen = new Set<string>();
  const expanded: string[] = [];

  while (queue.length > 0) {
    const segment = queue.shift()!.trim();
    if (!segment) continue;
    const key = segment.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    expanded.push(segment);

    for (const payload of extractNestedShellPayloads(segment)) {
      queue.push(...splitShellCommandSegments(payload));
    }
  }

  return expanded;
}
