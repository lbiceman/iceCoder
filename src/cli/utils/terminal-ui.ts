/**
 * 终端 UI 工具。
 * ANSI 颜色、spinner、格式化输出。
 * 不依赖外部库，纯 ANSI 转义码实现。
 */

// ── ANSI 颜色 ──

const isColorSupported = process.stdout.isTTY !== false && !process.env.NO_COLOR;

function ansi(code: string): string {
  return isColorSupported ? `\x1b[${code}m` : '';
}

export const c = {
  reset: ansi('0'),
  bold: ansi('1'),
  dim: ansi('2'),
  italic: ansi('3'),
  underline: ansi('4'),
  // 前景色
  red: ansi('31'),
  green: ansi('32'),
  yellow: ansi('33'),
  blue: ansi('34'),
  magenta: ansi('35'),
  cyan: ansi('36'),
  white: ansi('37'),
  gray: ansi('90'),
};

// ── 格式化输出 ──

export function info(msg: string): void {
  console.log(`${c.cyan}ℹ${c.reset} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${c.green}✓${c.reset} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${c.yellow}⚠${c.reset} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${c.red}✗${c.reset} ${msg}`);
}

export function toolCall(name: string, argsPreview: string): void {
  const truncated = argsPreview.length > 80 ? argsPreview.substring(0, 80) + '…' : argsPreview;
  process.stdout.write(`  ${c.dim}🔧 ${name}(${truncated})${c.reset}`);
}

export function toolResult(ok: boolean): void {
  console.log(ok ? ` ${c.green}✓${c.reset}` : ` ${c.red}✗${c.reset}`);
}

export function aiText(text: string): void {
  console.log(`\n${text}\n`);
}

export function divider(): void {
  const width = Math.min(process.stdout.columns || 80, 80);
  console.log(c.dim + '─'.repeat(width) + c.reset);
}

// ── Spinner ──

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    if (!process.stdout.isTTY) return;
    this.timer = setInterval(() => {
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
      process.stdout.write(`\r${c.cyan}${f}${c.reset} ${this.message}`);
      this.frame++;
    }, 80);
  }

  update(message: string): void {
    this.message = message;
  }

  stop(finalMessage?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write('\r' + ' '.repeat((process.stdout.columns || 80)) + '\r');
    }
    if (finalMessage) {
      console.log(finalMessage);
    }
  }
}

// ── 表格输出 ──

export function table(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
    return Math.max(h.length, maxRow);
  });

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('  ');
  const separator = colWidths.map((w) => '─'.repeat(w)).join('──');

  console.log(`${c.bold}${headerLine}${c.reset}`);
  console.log(c.dim + separator + c.reset);

  for (const row of rows) {
    const line = row.map((cell, i) => (cell || '').padEnd(colWidths[i])).join('  ');
    console.log(line);
  }
}
