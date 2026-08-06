/**
 * PTY 交互提示启发式检测（需求 §5.3）。
 *
 * 匹配输出尾部窗口；非 100% 准确 — AI 应结合 raw output 自行判断。
 * password / passphrase 等输入态不走 shellMandatoryConfirm（Wave 5 联测 T32）。
 */

export interface PromptPattern {
  re: RegExp;
  hint: string;
}

/** 默认提示模式（顺序优先：更具体的规则在前） */
export const DEFAULT_PROMPT_PATTERNS: PromptPattern[] = [
  { re: /password\s*:/i, hint: 'password' },
  { re: /请输入密码/, hint: 'password' },
  { re: /Passphrase\s+for\s+key/i, hint: 'passphrase' },
  { re: /\[sudo\]\s+password/i, hint: 'password' },
  { re: /\(yes\/no\)|\[Y\/n\]/i, hint: 'yes_no' },
  { re: /请输入/, hint: 'text' },
  { re: /input\s*:/i, hint: 'text' },
];

/** 尾部扫描默认窗口（字节） */
export const PROMPT_TAIL_BYTES = 2048;

export interface PromptDetectionResult {
  awaitingInput: boolean;
  promptHint: string | null;
  promptText: string | null;
}

/**
 * 在输出尾部窗口中检测交互提示。
 *
 * @param text 待扫描文本（通常为 PTY 输出尾部）
 * @param patterns 可配置模式列表
 * @param tailBytes 仅扫描末尾 N 字节
 */
export function detectPromptInTail(
  text: string,
  patterns: PromptPattern[] = DEFAULT_PROMPT_PATTERNS,
  tailBytes: number = PROMPT_TAIL_BYTES,
): PromptDetectionResult {
  if (!text) {
    return { awaitingInput: false, promptHint: null, promptText: null };
  }

  const tail = text.length > tailBytes ? text.slice(-tailBytes) : text;

  for (const { re, hint } of patterns) {
    const match = tail.match(re);
    if (match) {
      return {
        awaitingInput: true,
        promptHint: hint,
        promptText: extractPromptText(tail, match),
      };
    }
  }

  return { awaitingInput: false, promptHint: null, promptText: null };
}

/** 从匹配位置提取可读提示文本（优先含 match 的行） */
function extractPromptText(tail: string, match: RegExpMatchArray): string {
  const idx = match.index ?? tail.length - match[0].length;
  const lineStart = tail.lastIndexOf('\n', idx - 1) + 1;
  let lineEnd = tail.indexOf('\n', idx);
  if (lineEnd === -1) lineEnd = tail.length;
  const line = tail.slice(lineStart, lineEnd).replace(/\r$/, '').trim();
  if (line.length > 0) return line.slice(0, 200);
  return match[0].trim().slice(0, 200);
}
