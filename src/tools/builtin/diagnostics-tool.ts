/**
 * 项目诊断。有 tsconfig 时用 TypeScript 程序收集 path:line。
 * 有 eslint 配置且本地装了 eslint 时再跑一遍。不改文件。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type * as TsTypes from 'typescript';
import type { RegisteredTool } from '../types.js';

type TypeScriptModule = typeof TsTypes;

/**
 * 安装包不带 typescript。启动时不能静态 import，否则服务端起不来。
 * 先用工作区自己的 typescript，开发态再退回本仓库的 node_modules。
 */
function loadTypeScript(workDir: string): TypeScriptModule | null {
  const attempts = [
    path.join(workDir, 'package.json'),
    import.meta.url,
  ];
  for (const from of attempts) {
    try {
      return createRequire(from)('typescript') as TypeScriptModule;
    } catch {
      // 这个位置没有 typescript，试下一个
    }
  }
  return null;
}

const MAX_FINDINGS = 40;
const MAX_CHARS = 8_000;
const ESLINT_TIMEOUT_MS = 20_000;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatTscDiagnostics(
  ts: TypeScriptModule,
  workDir: string,
  diagnostics: readonly TsTypes.Diagnostic[],
): string {
  const lines: string[] = [];
  for (const diagnostic of diagnostics) {
    if (lines.length >= MAX_FINDINGS) break;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    if (!diagnostic.file || diagnostic.start === undefined) {
      lines.push(`TS${diagnostic.code}: ${message}`);
      continue;
    }
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const rel = path.relative(workDir, diagnostic.file.fileName).replace(/\\/g, '/');
    const category = ts.DiagnosticCategory[diagnostic.category]?.toLowerCase() ?? 'error';
    lines.push(`${rel}:${pos.line + 1}:${pos.character + 1} ${category} TS${diagnostic.code}: ${message}`);
  }
  const extra = diagnostics.length > lines.length ? `\n…${diagnostics.length - lines.length} more` : '';
  return `${lines.join('\n')}${extra}`;
}

async function runTsc(workDir: string, target: string): Promise<string | null> {
  const ts = loadTypeScript(workDir);
  if (!ts) {
    const localConfig = path.join(workDir, 'tsconfig.json');
    if (await exists(localConfig)) {
      return 'tsconfig.json found, but typescript is not installed. Install it in the workspace, or read the file directly.';
    }
    return null;
  }
  const configPath = ts.findConfigFile(workDir, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return null;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    return formatTscDiagnostics(ts, workDir, [read.error]);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  let diagnostics = ts.getPreEmitDiagnostics(program);
  if (target) {
    const needle = target.replace(/\\/g, '/');
    const filtered = diagnostics.filter(diagnostic => {
      if (!diagnostic.file) return true;
      const rel = path.relative(workDir, diagnostic.file.fileName).replace(/\\/g, '/');
      return rel === needle || rel.startsWith(`${needle}/`) || rel.endsWith(needle);
    });
    if (filtered.length > 0) diagnostics = filtered;
  }
  if (diagnostics.length === 0) return 'tsc: no diagnostics';
  return formatTscDiagnostics(ts, workDir, diagnostics);
}

async function eslintConfigPath(workDir: string): Promise<string | null> {
  const names = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js'];
  for (const name of names) {
    const candidate = path.join(workDir, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function runEslint(workDir: string, bin: string, target: string): Promise<string> {
  return new Promise(resolve => {
    const args = [bin, '--no-color', '--format', 'unix', target || '.'];
    const child = spawn(process.execPath, args, {
      cwd: workDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const take = (chunk: Buffer) => {
      if (out.length >= MAX_CHARS) return;
      out += chunk.toString('utf8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => {
      child.kill();
    }, ESLINT_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

async function runEslintIfInstalled(workDir: string, target: string): Promise<string | null> {
  if (!await eslintConfigPath(workDir)) return null;
  const bin = path.join(workDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!await exists(bin)) return 'eslint config found, but node_modules/eslint is not installed';
  const output = await runEslint(workDir, bin, target);
  return output || 'eslint: no diagnostics';
}

function targetInsideWorkspace(workDir: string, target: string): string | null {
  if (!target) return '';
  const abs = path.resolve(workDir, target);
  const rel = path.relative(workDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function clip(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n…[diagnostics truncated]`;
}

export function createDiagnosticsTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'diagnostics',
      description:
        'Collect project diagnostics as path:line findings. Uses tsc when tsconfig.json exists, and local eslint when a config and eslint are installed. Does not modify files.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Optional file or directory relative to the workspace. Omit to diagnose the project.',
          },
        },
      },
    },
    handler: async (args) => {
      const rawTarget = typeof args.target === 'string' ? args.target.trim() : '';
      const target = targetInsideWorkspace(workDir, rawTarget);
      if (target === null) {
        return { success: false, output: '', error: 'target must stay inside the workspace.' };
      }
      const parts: string[] = [];
      const tscOutput = await runTsc(workDir, target);
      if (tscOutput) parts.push(tscOutput);
      const eslintOutput = await runEslintIfInstalled(workDir, target);
      if (eslintOutput) parts.push(eslintOutput);
      if (parts.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No tsconfig.json or eslint config in the workspace. Pass target only after one of those exists, or read the file directly.',
        };
      }
      return { success: true, output: clip(parts.join('\n\n')) };
    },
  };
}
