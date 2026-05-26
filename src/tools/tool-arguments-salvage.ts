/**
 * 从截断/非法 JSON 字符串中 salvage 工具参数字段。
 */

export const SALVAGE_TRUNCATED_KEY = '_salvageTruncated';

const STRING_FIELDS = ['path', 'filePath', 'content', 'search', 'replace', 'patch', 'command', 'cmd'] as const;

function unescapePartialJsonString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      switch (next) {
        case 'n': out += '\n'; i++; continue;
        case 't': out += '\t'; i++; continue;
        case 'r': out += '\r'; i++; continue;
        case '"': out += '"'; i++; continue;
        case '\\': out += '\\'; i++; continue;
        case '/': out += '/'; i++; continue;
        case 'u': {
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 5;
            continue;
          }
          break;
        }
        default:
          out += next;
          i++;
          continue;
      }
    }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

function extractStringField(raw: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"`, 'g');
  const match = re.exec(raw);
  if (!match) return undefined;
  const valueStart = match.index + match[0].length;
  return unescapePartialJsonString(raw.slice(valueStart));
}

/**
 * 尝试从无法 JSON.parse 的 payload 中提取常见工具字段。
 */
export function salvageTruncatedToolJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;

  const salvaged: Record<string, unknown> = {};
  for (const field of STRING_FIELDS) {
    const value = extractStringField(trimmed, field);
    if (value !== undefined && value.length > 0) {
      salvaged[field] = value;
    }
  }

  if (Object.keys(salvaged).length === 0) return null;
  salvaged[SALVAGE_TRUNCATED_KEY] = true;
  return salvaged;
}

export function isSalvagedTruncatedArguments(args: Record<string, unknown>): boolean {
  return args[SALVAGE_TRUNCATED_KEY] === true;
}

export function buildSalvageTruncatedError(toolName: string, args: Record<string, unknown>): string {
  const path = args.path ?? args.filePath ?? '(unknown path)';
  const contentLen = typeof args.content === 'string' ? args.content.length
    : typeof args.search === 'string' ? args.search.length
      : typeof args.patch === 'string' ? args.patch.length
        : 0;
  return [
    `Tool arguments for ${toolName} appear truncated (incomplete JSON after max_tokens).`,
    `Salvaged path: ${path}${contentLen > 0 ? `; partial payload ~${contentLen} chars` : ''}.`,
    'Do NOT retry the same full-file write.',
    'Use patch_file (small unified diff hunk), edit_file (short exact search/replace), or split into smaller writes/appends.',
  ].join(' ');
}
