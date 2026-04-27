/**
 * 健壮的 JSON 解析器。
 *
 * LLM 输出的 JSON 经常不完美——可能有前后缀文本、markdown 代码块包裹、
 * 尾部逗号、单引号等问题。此模块提供多层回退的解析策略。
 */

/**
 * 从 LLM 输出中提取并解析 JSON 对象。
 * 多层回退策略：
 * 1. 直接解析（输出就是纯 JSON）
 * 2. 提取 markdown 代码块中的 JSON
 * 3. 正则提取第一个 {...} 或 [...]
 * 4. 修复常见格式错误后重试
 *
 * @param raw - LLM 的原始输出文本
 * @param expectArray - 是否期望 JSON 数组（true）还是对象（false）
 * @returns 解析后的对象/数组，解析失败返回 null
 */
export function parseLLMJson<T = any>(raw: string, expectArray: boolean = false): T | null {
  const trimmed = raw.trim();

  // 策略 1：直接解析
  try {
    const parsed = JSON.parse(trimmed);
    if (expectArray ? Array.isArray(parsed) : typeof parsed === 'object') {
      return parsed as T;
    }
  } catch { /* 继续下一策略 */ }

  // 策略 2：提取 markdown 代码块
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (expectArray ? Array.isArray(parsed) : typeof parsed === 'object') {
        return parsed as T;
      }
    } catch { /* 继续 */ }
  }

  // 策略 3：正则提取第一个完整的 JSON 结构
  const pattern = expectArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const jsonMatch = trimmed.match(pattern);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (expectArray ? Array.isArray(parsed) : typeof parsed === 'object') {
        return parsed as T;
      }
    } catch {
      // 策略 4：修复常见格式错误后重试
      const fixed = fixCommonJsonErrors(jsonMatch[0]);
      try {
        const parsed = JSON.parse(fixed);
        if (expectArray ? Array.isArray(parsed) : typeof parsed === 'object') {
          return parsed as T;
        }
      } catch { /* 放弃 */ }
    }
  }

  // 策略 5：如果期望数组但得到了对象，尝试提取对象中的数组字段
  if (expectArray) {
    const objMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        const obj = JSON.parse(objMatch[0]);
        // 查找第一个数组类型的字段
        for (const value of Object.values(obj)) {
          if (Array.isArray(value)) {
            return value as T;
          }
        }
      } catch { /* 放弃 */ }
    }
  }

  return null;
}

/**
 * 修复 LLM 输出中常见的 JSON 格式错误。
 */
function fixCommonJsonErrors(json: string): string {
  let fixed = json;

  // 移除尾部逗号（对象和数组中）
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // 单引号替换为双引号（简单场景，不处理嵌套引号）
  // 只在键名位置替换，避免破坏值中的合法单引号
  fixed = fixed.replace(/(?<=[\[{,]\s*)'([^']+)'(?=\s*:)/g, '"$1"');

  // 修复未转义的换行符（在字符串值中）
  fixed = fixed.replace(/(?<="[^"]*)\n(?=[^"]*")/g, '\\n');

  return fixed;
}

/**
 * 从 LLM 输出中提取 JSON 对象。
 * 便捷方法，等价于 parseLLMJson(raw, false)。
 */
export function parseLLMJsonObject<T = Record<string, any>>(raw: string): T | null {
  return parseLLMJson<T>(raw, false);
}

/**
 * 从 LLM 输出中提取 JSON 数组。
 * 便捷方法，等价于 parseLLMJson(raw, true)。
 */
export function parseLLMJsonArray<T = any[]>(raw: string): T | null {
  return parseLLMJson<T>(raw, true);
}
