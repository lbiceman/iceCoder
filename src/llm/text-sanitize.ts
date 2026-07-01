/**
 * OpenAI 适配层共用的文本清洗 / 工具参数解析工具。
 *
 * 这些逻辑此前在 `openai-adapter.ts` 与 `openai-responses-bridge.ts` 中各有
 * 一份完全相同的实现，现统一到此处作为单一来源，避免双份维护漂移。
 */

import type { ContentBlock } from './types.js';
import { normalizeToolArguments } from '../tools/tool-arguments-normalizer.js';

/**
 * 清理文本中可能导致 API JSON 解析失败的非法字符。
 * - ASCII 控制字符（保留 \t \n \r）
 * - lone surrogates（U+D800-U+DFFF，JSON 中非法）
 * - C1 控制字符（U+0080-U+009F）
 */
export function cleanText(text: string): string {
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x80-\x9F]/g, '');
  return text;
}

/**
 * 将内容从 string 或 ContentBlock[] 解析为纯文本，并做非法字符清洗。
 */
export function resolveContentText(content: string | ContentBlock[]): string {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else {
    text = content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text!)
      .join('\n');
  }
  return cleanText(text);
}

/**
 * 安全解析工具调用参数 JSON；失败时回退为 `{ raw: <原始串> }`。
 */
export function safeParseToolArguments(jsonStr: string): Record<string, unknown> {
  try {
    return normalizeToolArguments(JSON.parse(jsonStr)) as Record<string, unknown>;
  } catch {
    return normalizeToolArguments({ raw: jsonStr }) as Record<string, unknown>;
  }
}
