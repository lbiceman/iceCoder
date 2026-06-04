/**
 * 搜索工具集：Glob 按路径找文件，Grep 搜内容（ripgrep）。
 */

import path from 'node:path';
import type { RegisteredTool } from '../types.js';
import { resolveRipgrepSearchScope } from '../../shared/path-scope.js';
import { getMaxToolOutputChars } from '../tool-output-limits.js';
import {
  appendTruncationNotice,
  DEFAULT_GLOB_MAX_FILES,
  DEFAULT_GREP_CONTENT_MATCHES,
  DEFAULT_GREP_MAX_RESULTS,
  formatGrepContentBlocks,
  isRipgrepNoMatch,
  parseRipgrepJsonMatches,
  resolveRipgrepPath,
  runGlobFiles,
  runRipgrep,
} from './ripgrep-runner.js';

function capMaxResults(n: unknown, fallback: number, ceiling: number): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), ceiling);
}

/**
 * 创建 Glob + Grep 工具。
 */
export function createSearchTools(workDir: string): RegisteredTool[] {
  const maxOut = () => getMaxToolOutputChars();

  return [
    {
      definition: {
        name: 'glob',
        description:
          'Find files by path/name glob (e.g. "**/*.ts", "src/**/*.test.js"). Sorted by modification time when supported. Does not search file contents — use grep for that. Prefer this before read_file when you do not know exact paths.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern relative to search directory' },
            path: { type: 'string', description: 'Directory to search (relative to work dir or absolute), default "."' },
            directory: { type: 'string', description: 'Alias for path' },
            maxResults: { type: 'number', description: 'Max file paths to return', default: DEFAULT_GLOB_MAX_FILES },
          },
          required: ['pattern'],
        },
      },
      handler: async (args) => {
        const pattern = String(args.pattern ?? args.glob ?? '').trim();
        if (!pattern) {
          return { success: false, output: '', error: 'pattern is required' };
        }
        const rg = await resolveRipgrepPath();
        if (!rg) {
          return { success: false, output: '', error: 'ripgrep (rg) is not available. Install ripgrep or add @vscode/ripgrep.' };
        }

        const scope = await resolveRipgrepSearchScope(
          workDir,
          (args.path ?? args.directory) as string | undefined,
        );
        if (!scope.ok) {
          return { success: false, output: '', error: scope.error };
        }
        const maxResults = capMaxResults(args.maxResults, DEFAULT_GLOB_MAX_FILES, 500);
        const limit = maxOut();

        const result = await runGlobFiles(scope.cwd, pattern, limit);

        if (result.timedOut) {
          return { success: false, output: '', error: 'glob search timed out' };
        }
        if (result.exitCode !== 0 && result.exitCode !== null && !isRipgrepNoMatch(result.exitCode, result.stderr)) {
          return { success: false, output: '', error: result.stderr || `rg exited ${result.exitCode}` };
        }

        let paths = result.stdout
          .split('\n')
          .map((p) => p.trim().replace(/\\/g, '/'))
          .filter(Boolean);
        const truncatedList = paths.length > maxResults;
        if (truncatedList) paths = paths.slice(0, maxResults);

        if (paths.length === 0) {
          return { success: true, output: `No files matched pattern: ${pattern}` };
        }

        const rel = (p: string) => {
          const abs = path.isAbsolute(p) ? p : path.join(scope.cwd, p);
          return path.relative(scope.cwd, abs).replace(/\\/g, '/');
        };

        const display = paths.map((p) => rel(p));
        const tail = truncatedList ? `\n... (truncated at ${maxResults} files)` : '';
        const body = `Found ${display.length} files matching "${pattern}":\n${display.join('\n')}${tail}`;
        return {
          success: true,
          output: appendTruncationNotice(body, result.truncated, false),
        };
      },
    },

    {
      definition: {
        name: 'grep',
        description:
          'Search file contents with ripgrep. Default output_mode is files_with_matches (paths only) — use read_file next. Use output_mode "content" for line matches; "count" for per-file match counts. Respects .gitignore.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern (regex unless fixed_strings:true)' },
            path: { type: 'string', description: 'Directory or file to search, default "."' },
            directory: { type: 'string', description: 'Alias for path' },
            glob: { type: 'string', description: 'Filter files, e.g. "**/*.ts"' },
            output_mode: {
              type: 'string',
              description: 'files_with_matches (default) | content | count',
              default: 'files_with_matches',
            },
            fixed_strings: { type: 'boolean', description: 'Literal match (no regex)', default: false },
            case_insensitive: { type: 'boolean', description: 'Case insensitive', default: false },
            context_lines: { type: 'number', description: 'Lines of context for content mode', default: 2 },
            maxResults: { type: 'number', description: 'Max paths or match blocks', default: DEFAULT_GREP_MAX_RESULTS },
            multiline: { type: 'boolean', description: 'Multiline match (. matches newline)', default: false },
          },
          required: ['pattern'],
        },
      },
      handler: async (args) => {
        const pattern = String(args.pattern ?? args.query ?? args.keyword ?? '').trim();
        if (!pattern) {
          return { success: false, output: '', error: 'pattern is required' };
        }
        const rg = await resolveRipgrepPath();
        if (!rg) {
          return { success: false, output: '', error: 'ripgrep (rg) is not available. Install ripgrep or add @vscode/ripgrep.' };
        }

        const scope = await resolveRipgrepSearchScope(
          workDir,
          (args.path ?? args.directory) as string | undefined,
        );
        if (!scope.ok) {
          return { success: false, output: '', error: scope.error };
        }
        const rgTarget = scope.rgTarget;
        const outputMode = String(args.output_mode ?? 'files_with_matches').toLowerCase();
        const maxResults = capMaxResults(
          args.maxResults,
          outputMode === 'content' ? DEFAULT_GREP_CONTENT_MATCHES : DEFAULT_GREP_MAX_RESULTS,
          500,
        );
        const limit = maxOut();

        const rgArgs: string[] = [];
        if (args.fixed_strings) rgArgs.push('-F');
        if (args.case_insensitive) rgArgs.push('-i');
        if (args.multiline) rgArgs.push('-U', '--multiline-dotall');

        if (typeof args.glob === 'string' && args.glob.trim()) {
          rgArgs.push('-g', args.glob.trim());
        }
        if (typeof args.filePattern === 'string' && args.filePattern.trim()) {
          rgArgs.push('-g', args.filePattern.trim());
        }

        let body: string;
        let truncated = false;
        let timedOut = false;

        if (outputMode === 'count') {
          rgArgs.push('-c', '--', pattern, rgTarget);
          const result = await runRipgrep({ cwd: scope.cwd, args: rgArgs, maxOutputChars: limit });
          truncated = result.truncated;
          timedOut = result.timedOut;
          if (timedOut) return { success: false, output: '', error: 'grep timed out' };
          if (result.exitCode !== 0 && result.exitCode !== null && !isRipgrepNoMatch(result.exitCode, result.stderr)) {
            return { success: false, output: '', error: result.stderr || `rg exited ${result.exitCode}` };
          }
          const lines = result.stdout.split('\n').filter(Boolean).slice(0, maxResults);
          body = lines.length ? lines.join('\n') : 'No matches found.';
        } else if (outputMode === 'content') {
          const ctx = capMaxResults(args.context_lines, 2, 10);
          rgArgs.push('--json', '-C', String(ctx), '-m', String(maxResults), '--', pattern, rgTarget);
          const result = await runRipgrep({ cwd: scope.cwd, args: rgArgs, maxOutputChars: limit });
          truncated = result.truncated;
          timedOut = result.timedOut;
          if (timedOut) return { success: false, output: '', error: 'grep timed out' };
          if (result.exitCode !== 0 && result.exitCode !== null && !isRipgrepNoMatch(result.exitCode, result.stderr)) {
            return { success: false, output: '', error: result.stderr || `rg exited ${result.exitCode}` };
          }
          const blocks = parseRipgrepJsonMatches(result.stdout, maxResults);
          body = formatGrepContentBlocks(blocks, maxResults);
          if (!body.trim()) body = 'No matches found.';
        } else {
          rgArgs.push('-l', '--', pattern, rgTarget);
          const result = await runRipgrep({ cwd: scope.cwd, args: rgArgs, maxOutputChars: limit });
          truncated = result.truncated;
          timedOut = result.timedOut;
          if (timedOut) return { success: false, output: '', error: 'grep timed out' };
          if (result.exitCode !== 0 && result.exitCode !== null && !isRipgrepNoMatch(result.exitCode, result.stderr)) {
            return { success: false, output: '', error: result.stderr || `rg exited ${result.exitCode}` };
          }
          let paths = result.stdout.split('\n').map((p) => p.trim().replace(/\\/g, '/')).filter(Boolean);
          const truncatedList = paths.length > maxResults;
          if (truncatedList) paths = paths.slice(0, maxResults);
          if (paths.length === 0) {
            body = 'No matches found.';
          } else {
            const tail = truncatedList ? `\n... (truncated at ${maxResults} paths)` : '';
            body = `Found ${paths.length} files:\n${paths.join('\n')}${tail}`;
          }
        }

        return {
          success: true,
          output: appendTruncationNotice(body, truncated, timedOut),
        };
      },
    },
  ];
}
