/**
 * 推理强度：档位列表来自模型配置（逗号分隔，如 `low,high,max`），
 * 选中值原样写入 Chat Completions 的 reasoning_effort / Responses 的 reasoning.effort。
 */

/** 单个档位：小写字母开头，允许字母数字、下划线、点、连字符。 */
export const REASONING_EFFORT_TOKEN_RE = /^[a-z][\w.-]{0,31}$/i;

export type ReasoningEffort = string;

export function isReasoningEffortToken(value: unknown): value is string {
  return typeof value === 'string' && REASONING_EFFORT_TOKEN_RE.test(value.trim());
}

/** 将配置字符串解析为去重后的档位列表（非法片段跳过）。 */
export function parseReasoningEffortLevels(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (!token || !REASONING_EFFORT_TOKEN_RE.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export type ParseReasoningEffortLevelsResult =
  | { ok: true; levels: string[]; stored?: string }
  | { ok: false; error: string };

/** 保存配置时用：非法片段直接报错，不静默丢弃。 */
export function parseReasoningEffortLevelsStrict(raw: unknown): ParseReasoningEffortLevelsResult {
  if (raw == null) return { ok: true, levels: [] };
  if (typeof raw !== 'string') {
    return { ok: false, error: '推理强度必须是逗号分隔的字符串' };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, levels: [] };

  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of trimmed.split(',')) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (!REASONING_EFFORT_TOKEN_RE.test(token)) {
      return { ok: false, error: `推理强度含非法档位：${part.trim()}` };
    }
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return { ok: true, levels: out, stored: out.length > 0 ? out.join(',') : undefined };
}

/** 单次请求选中的档位；非法或空值返回 undefined。 */
export function parseReasoningEffort(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  return REASONING_EFFORT_TOKEN_RE.test(value) ? value : undefined;
}

/**
 * 映射到厂商接受的档位：未配置列表则不发送；
 * 选中值不在列表内时回落到中间档（长度为 1 时即该档）。
 */
export function resolveWireReasoningEffort(
  selected: unknown,
  allowedLevels: string[] | undefined,
): string | undefined {
  if (!allowedLevels || allowedLevels.length === 0) return undefined;
  const parsed = parseReasoningEffort(selected);
  if (parsed && allowedLevels.includes(parsed)) return parsed;
  return allowedLevels[Math.floor((allowedLevels.length - 1) / 2)];
}

/** Chat Completions：顶层 reasoning_effort。 */
export function applyReasoningEffortToChatParams(
  params: Record<string, unknown>,
  effort: string | undefined,
): void {
  if (!effort) return;
  params.reasoning_effort = effort;
}

/** Responses API：reasoning.effort。 */
export function applyReasoningEffortToResponsesParams(
  params: Record<string, unknown>,
  effort: string | undefined,
): void {
  if (!effort) return;
  const existing = params.reasoning;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    params.reasoning = { ...(existing as Record<string, unknown>), effort };
    return;
  }
  params.reasoning = { effort };
}
