/**
 * 头尾截断（Claude Code middle-truncation / Codex head+tail / OpenCode bash tail）。
 *
 * 编译器和测试失败栈几乎总在输出末尾；只留前缀会把真正的错误裁掉。
 */

export interface TruncateHeadTailOptions {
  /** 保留开头的比例，默认 0.2（尾部 80%） */
  headRatio?: number;
  /** 覆盖省略标记；默认含原始长度 */
  marker?: string;
  /** 完整输出落盘路径，写入提示让模型去读/搜 */
  spillPath?: string;
}

/**
 * 超长文本保留开头 + 末尾。结果长度约为 budget + 标记。
 * 若原文只比 budget 长一点（加标记后省不下），原样返回。
 */
export function truncateHeadTail(
  text: string,
  budget: number,
  options: TruncateHeadTailOptions = {},
): string {
  if (budget <= 0 || text.length <= budget) return text;

  const headRatio = clampRatio(options.headRatio ?? 0.2);
  const spillHint = options.spillPath
    ? `\nFull output saved to: ${options.spillPath}\nUse read_file with offset near the end, or grep for Error/FAIL/error.`
    : '';
  const marker = (options.marker
    ?? `\n...[${Math.max(0, text.length - budget)} characters omitted from middle; original ${text.length} characters]...\n`)
    + spillHint;

  if (text.length <= budget + marker.length) return text;

  const usable = Math.max(2, budget);
  let headLen = Math.max(1, Math.floor(usable * headRatio));
  let tailLen = Math.max(1, usable - headLen);
  if (headLen + tailLen >= text.length) return text;

  return `${text.slice(0, headLen)}${marker}${text.slice(-tailLen)}`;
}

function clampRatio(n: number): number {
  if (!Number.isFinite(n)) return 0.2;
  return Math.min(0.8, Math.max(0.05, n));
}

/**
 * 进程输出环形：超出上限后保留头部 + 滚动尾部（对齐 Codex unified-exec cap）。
 */
export class HeadTailCharBuffer {
  private head = '';
  private tail = '';
  private overflow = false;
  private totalChars = 0;
  private readonly headBudget: number;
  private readonly tailBudget: number;

  constructor(maxChars: number, headRatio = 0.25) {
    const max = Math.max(64, Math.floor(maxChars));
    const ratio = clampRatio(headRatio);
    this.headBudget = Math.max(16, Math.floor(max * ratio));
    this.tailBudget = Math.max(16, max - this.headBudget);
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.totalChars += chunk.length;
    if (!this.overflow) {
      this.head += chunk;
      const cap = this.headBudget + this.tailBudget;
      if (this.head.length <= cap) return;
      this.overflow = true;
      const extra = this.head.slice(this.headBudget);
      this.head = this.head.slice(0, this.headBudget);
      this.tail = extra.slice(-this.tailBudget);
      return;
    }
    this.tail += chunk;
    if (this.tail.length > this.tailBudget) {
      this.tail = this.tail.slice(-this.tailBudget);
    }
  }

  get truncated(): boolean {
    return this.overflow;
  }

  get totalCharsWritten(): number {
    return this.totalChars;
  }

  toString(): string {
    if (!this.overflow) return this.head;
    const omitted = Math.max(0, this.totalChars - this.head.length - this.tail.length);
    return `${this.head}\n...[${omitted} characters omitted from middle]...\n${this.tail}`;
  }
}
