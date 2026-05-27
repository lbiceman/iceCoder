/**
 * run_command 内联脚本检测：node -e / 超长单行命令在 Windows 下易因转义失败。
 */

const NODE_EVAL_RE = /\bnode(?:\.exe)?\s+(?:-(?:e|eval)|--eval)\s+/i;

/** 单行命令长度超过此值时建议写脚本文件（全平台）。 */
export const INLINE_SCRIPT_LONG_COMMAND_CHARS = 600;

export interface InlineScriptAdvisory {
  /** true 时不执行命令，直接返回错误提示 */
  block: boolean;
  message: string;
}

function extractNodeEvalPayload(command: string): string | null {
  const match = command.match(NODE_EVAL_RE);
  if (!match) return null;
  return command.slice(match.index! + match[0].length).trim();
}

function isComplexInlineScript(payload: string): boolean {
  if (payload.length > 80) return true;
  if (/\\["'`]/.test(payload)) return true;
  if ((payload.match(/"/g) ?? []).length >= 4) return true;
  if ((payload.match(/'/g) ?? []).length >= 4) return true;
  if (/\$\(/.test(payload) || /`/.test(payload)) return true;
  return false;
}

function buildScriptFileHint(kind: 'node-eval' | 'long-line'): string {
  const reason = kind === 'node-eval'
    ? 'Inline `node -e` scripts are fragile on Windows (quoting/escaping).'
    : 'Very long one-line shell commands are hard to quote correctly.';
  return [
    reason,
    'Write the logic to a file under `scripts/` (e.g. `scripts/check.mjs` or `scripts/check.cjs`), then run:',
    '  node scripts/check.mjs',
    'Do not retry the same inline command.',
  ].join(' ');
}

/**
 * 分析命令是否应拦截或提示改用脚本文件。
 * @returns null 表示无需特殊处理
 */
export function analyzeInlineScriptCommand(command: string): InlineScriptAdvisory | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const nodePayload = extractNodeEvalPayload(trimmed);
  if (nodePayload !== null) {
    const complex = isComplexInlineScript(nodePayload);
    if (process.platform === 'win32' && complex) {
      return { block: true, message: buildScriptFileHint('node-eval') };
    }
    if (nodePayload.length > 400) {
      return {
        block: false,
        message: `[advisory] Long inline node -e (${nodePayload.length} chars). ${buildScriptFileHint('node-eval')}`,
      };
    }
    return null;
  }

  if (!trimmed.includes('\n') && trimmed.length > INLINE_SCRIPT_LONG_COMMAND_CHARS) {
    return {
      block: process.platform === 'win32',
      message: buildScriptFileHint('long-line'),
    };
  }

  return null;
}
