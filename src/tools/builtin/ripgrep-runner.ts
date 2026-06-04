/**
 * ripgrep 封装：Glob / Grep 工具共用。
 */

import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_GLOB_MAX_FILES = 100;
export const DEFAULT_GREP_MAX_RESULTS = 100;
export const DEFAULT_GREP_CONTENT_MATCHES = 40;

let cachedRgPath: string | null | undefined;

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 解析 ripgrep 可执行文件路径（缓存）；不可用则返回 null。 */
export async function resolveRipgrepPath(): Promise<string | null> {
  if (cachedRgPath !== undefined) {
    return cachedRgPath === '' ? null : cachedRgPath;
  }

  try {
    const mod = await import('@vscode/ripgrep');
    const p = (mod as { rgPath?: string }).rgPath;
    if (p && await isExecutable(p)) {
      cachedRgPath = p;
      return cachedRgPath;
    }
  } catch {
    /* package or binary missing */
  }

  if (await isExecutable('rg')) {
    cachedRgPath = 'rg';
    return cachedRgPath;
  }

  cachedRgPath = '';
  return null;
}

export interface RipgrepRunOptions {
  cwd: string;
  args: string[];
  maxOutputChars: number;
  timeoutMs?: number;
}

export interface RipgrepRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

/** 运行 rg；stdout 达到 maxOutputChars 时终止子进程并标记 truncated。 */
export function runRipgrep(options: RipgrepRunOptions): Promise<RipgrepRunResult> {
  const { cwd, args, maxOutputChars, timeoutMs = 120_000 } = options;
  return new Promise((resolve) => {
    void (async () => {
      const rg = await resolveRipgrepPath();
      if (!rg) {
        resolve({
          stdout: '',
          stderr: 'ripgrep not available',
          exitCode: null,
          truncated: false,
          timedOut: false,
        });
        return;
      }

      const proc = spawn(rg, args, {
        cwd: path.resolve(cwd),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (truncated) return;
        stdout += chunk.toString('utf8');
        if (stdout.length > maxOutputChars) {
          truncated = true;
          stdout = stdout.slice(0, maxOutputChars);
          proc.kill('SIGTERM');
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 4_000) stderr = stderr.slice(0, 4_000);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: err.message,
          exitCode: null,
          truncated,
          timedOut,
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr.trim(),
          exitCode: code,
          truncated,
          timedOut,
        });
      });
    })();
  });
}

/** rg 未找到匹配时 exit 1，仍视为成功搜索。 */
export function isRipgrepNoMatch(exitCode: number | null, stderr: string): boolean {
  return exitCode === 1 && !stderr;
}

export function appendTruncationNotice(output: string, truncated: boolean, timedOut: boolean): string {
  const parts: string[] = [output];
  if (truncated) parts.push('\n[... output truncated at size limit; narrow pattern or path ...]');
  if (timedOut) parts.push('\n[... ripgrep timed out; narrow directory or pattern ...]');
  return parts.filter(Boolean).join('');
}

/** Glob 文件列表；不支持 --sort 时自动回退。 */
export async function runGlobFiles(
  searchDir: string,
  pattern: string,
  maxOutputChars: number,
): Promise<RipgrepRunResult> {
  const baseArgs = ['--files', '--no-ignore', '-g', pattern];
  const withSort = [...baseArgs, '--sort', 'modified'];
  let result = await runRipgrep({ cwd: searchDir, args: withSort, maxOutputChars });
  if (
    result.exitCode !== 0
    && result.exitCode !== null
    && !isRipgrepNoMatch(result.exitCode, result.stderr)
    && /sort|unknown flag|unrecognized/i.test(result.stderr)
  ) {
    result = await runRipgrep({ cwd: searchDir, args: baseArgs, maxOutputChars });
  }
  return result;
}

export interface GrepContentBlock {
  path: string;
  lineNumber: number;
  line: string;
}

/** 解析 rg --json 的 match 行（跨平台路径安全）。 */
export function parseRipgrepJsonMatches(stdout: string, maxMatches: number): GrepContentBlock[] {
  const blocks: GrepContentBlock[] = [];
  for (const rawLine of stdout.split('\n')) {
    if (blocks.length >= maxMatches) break;
    const line = rawLine.trim();
    if (!line) continue;
    let obj: { type?: string; data?: Record<string, unknown> };
    try {
      obj = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
    } catch {
      continue;
    }
    if (obj.type !== 'match' || !obj.data) continue;
    const data = obj.data;
    const pathObj = data.path as { text?: string } | undefined;
    const linesObj = data.lines as { text?: string } | undefined;
    const pathText = pathObj?.text;
    const lineText = linesObj?.text;
    const lineNumber = typeof data.line_number === 'number' ? data.line_number : 0;
    if (!pathText || lineText === undefined) continue;
    blocks.push({
      path: pathText.replace(/\\/g, '/'),
      lineNumber,
      line: lineText,
    });
  }
  return blocks;
}

export function formatGrepContentBlocks(blocks: GrepContentBlock[], maxMatches: number): string {
  if (blocks.length === 0) return '';
  const out: string[] = [];
  for (const b of blocks.slice(0, maxMatches)) {
    out.push(`${b.path}:${b.lineNumber}\n${b.line}`);
  }
  if (blocks.length > maxMatches) {
    out.push(`\n... (truncated at ${maxMatches} matches)`);
  }
  return out.join('\n\n');
}
