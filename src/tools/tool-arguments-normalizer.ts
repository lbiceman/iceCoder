/**
 * 工具参数归一化。
 *
 * 部分模型会把完整 JSON 参数包在单个 raw 字符串里，例如：
 *   { "raw": "{\"path\":\"a.ts\",\"content\":\"...\"}" }
 * 执行层需要展开为顶层 path/content/command 等字段。
 */

export function normalizeToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }

  const raw = args.raw;
  if (typeof raw !== 'string' || raw.length === 0) {
    return args;
  }

  // 仅当 raw 是唯一字段时展开，避免误伤合法的多字段参数。
  if (Object.keys(args).length !== 1) {
    return args;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 截断或非法 JSON：保持原样，由工具层返回明确错误。
  }

  return args;
}
