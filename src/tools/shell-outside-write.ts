/**
 * 执行前判断 shell 命令是否会写到锁定工作区以外。
 * 只看命令文本里直接写出的路径，不跟踪脚本运行后的写入。
 */

import os from 'node:os';
import path from 'node:path';

import { resolveMemoryRootForPath } from '../memory/file-memory/memory-write-pipeline.js';
import { isUnderRoot, realpathOfNearestExisting } from '../shared/path-scope.js';
import {
  extractNestedShellPayloads,
  splitShellCommandSegments,
  tokenizeShellCommand,
  type ShellCommandToken,
} from './shell-command-parser.js';

export const OUTSIDE_WORKSPACE_WRITE_CATEGORY = '工作区外写入';

export const OUTSIDE_WORKSPACE_WRITE_DENIAL_HINT =
  '不要换写法绕过；确实要写到工作区外，请让用户先切换工作区。';

const GLOBAL_PACKAGE_TARGET = '全局包目录';

const ALL_TARGET_COMMANDS = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'unlink',
  'remove-item', 'ri',
  'mv', 'move', 'ren', 'rename', 'move-item', 'mi', 'rename-item', 'rni',
  'mkdir', 'md', 'touch', 'new-item', 'ni',
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee', 'tee-object',
]);

const COPY_COMMANDS = new Set(['cp', 'copy', 'xcopy', 'robocopy', 'copy-item', 'cpi']);

const CMD_SLASH_COMMANDS = new Set([
  'del', 'erase', 'rd', 'rmdir', 'copy', 'xcopy', 'robocopy',
  'move', 'md', 'mkdir', 'ren', 'rename',
]);

const DIRECTORY_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl']);

const GLOBAL_SUBCOMMANDS = new Set(['install', 'i', 'add', 'uninstall', 'remove']);

export interface OutsideWorkspaceWriteFinding {
  outside: string[];
  unresolved: string[];
}

export interface FindOutsideWorkspaceWritesOptions {
  cwd: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
}

interface WalkState {
  cwd: string;
  cwdKnown: boolean;
  env: NodeJS.ProcessEnv;
  workspaceReal: string;
  tempReal: string;
  outside: Set<string>;
  unresolved: Set<string>;
  seen: Set<string>;
}

export function findOutsideWorkspaceWrites(
  command: string,
  options: FindOutsideWorkspaceWritesOptions,
): OutsideWorkspaceWriteFinding {
  const trimmed = command.trim();
  const outside = new Set<string>();
  const unresolved = new Set<string>();
  if (!trimmed) return { outside: [], unresolved: [] };

  const env = options.env ?? process.env;
  const state: WalkState = {
    cwd: path.resolve(options.cwd),
    cwdKnown: true,
    env,
    workspaceReal: realpathOfNearestExisting(path.resolve(options.workspaceRoot)),
    tempReal: realpathOfNearestExisting(path.resolve(os.tmpdir())),
    outside,
    unresolved,
    seen: new Set(),
  };
  walkCommand(trimmed, state.cwd, true, state, 0);
  return {
    outside: [...outside],
    unresolved: [...unresolved],
  };
}

function walkCommand(
  command: string,
  cwd: string,
  cwdKnown: boolean,
  state: WalkState,
  depth: number,
): void {
  if (depth > 8) return;
  const seenKey = `${cwdKnown ? '1' : '0'}\0${cwd}\0${command}`;
  if (state.seen.has(seenKey)) return;
  state.seen.add(seenKey);

  let dir = cwd;
  let known = cwdKnown;
  for (const segment of splitShellCommandSegments(command)) {
    for (const target of findRedirectTargets(segment)) {
      noteTarget(target, dir, known, state);
    }
    const cd = applyDirectoryChange(segment, dir, known, state.env);
    if (cd.handled) {
      dir = cd.cwd;
      known = cd.cwdKnown;
    } else {
      noteCommandTargets(segment, dir, known, state);
    }
    for (const payload of extractNestedShellPayloads(segment)) {
      walkCommand(payload, dir, known, state, depth + 1);
    }
  }
}

function noteCommandTargets(
  segment: string,
  cwd: string,
  cwdKnown: boolean,
  state: WalkState,
): void {
  const tokens = tokenizeShellCommand(segment);
  if (tokens.length === 0) return;
  const exe = commandBasename(tokens[0].value);
  if (isGlobalPackageInstall(exe, tokens)) {
    state.outside.add(GLOBAL_PACKAGE_TARGET);
  }
  const kind = ALL_TARGET_COMMANDS.has(exe) ? 'all' : COPY_COMMANDS.has(exe) ? 'copy' : null;
  if (!kind) return;

  const positionals: string[] = [];
  let destination: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (kind === 'copy') {
      const destFlag = /^(?:-Destination|--destination|-Dest)(?::|=)?(.*)$/i.exec(value);
      if (destFlag) {
        if (destFlag[1]) destination = destFlag[1];
        else if (tokens[i + 1]) destination = tokens[++i].value;
        continue;
      }
    }
    if (isOptionToken(value, exe)) continue;
    positionals.push(value);
  }

  const targets = kind === 'copy'
    ? [destination ?? positionals[positionals.length - 1]].filter((item): item is string => !!item)
    : positionals;
  for (const target of targets) noteTarget(target, cwd, cwdKnown, state);
}

function applyDirectoryChange(
  segment: string,
  cwd: string,
  cwdKnown: boolean,
  env: NodeJS.ProcessEnv,
): { handled: true; cwd: string; cwdKnown: boolean } | { handled: false } {
  const tokens = tokenizeShellCommand(segment);
  if (tokens.length === 0) return { handled: false };
  const exe = commandBasename(tokens[0].value);
  if (!DIRECTORY_COMMANDS.has(exe)) return { handled: false };
  if (exe === 'popd') return { handled: true, cwd, cwdKnown: false };

  let pathToken: string | undefined;
  let sawDriveFlag = false;
  for (let i = 1; i < tokens.length; i++) {
    const value = tokens[i].value;
    if ((exe === 'cd' || exe === 'chdir') && /^\/d$/i.test(value)) {
      sawDriveFlag = true;
      continue;
    }
    if (value === '-' || value === '--') return { handled: true, cwd, cwdKnown: false };
    const pathFlag = /^(?:-Path|-LiteralPath)(?::|=)?(.*)$/i.exec(value);
    if (pathFlag) {
      if (pathFlag[1]) pathToken = pathFlag[1];
      else if (tokens[i + 1]) pathToken = tokens[++i].value;
      continue;
    }
    if (value.startsWith('-')) continue;
    if (pathToken === undefined) pathToken = value;
  }

  if (pathToken === undefined) {
    if (sawDriveFlag || exe === 'pushd') return { handled: true, cwd, cwdKnown: false };
    return { handled: true, cwd: os.homedir(), cwdKnown: true };
  }

  const resolved = resolveCommandPath(pathToken, cwd, cwdKnown, env);
  if (!resolved.ok) return { handled: true, cwd, cwdKnown: false };
  return { handled: true, cwd: resolved.abs, cwdKnown: true };
}

function noteTarget(raw: string, cwd: string, cwdKnown: boolean, state: WalkState): void {
  const resolved = resolveCommandPath(raw, cwd, cwdKnown, state.env);
  if (!resolved.ok) {
    state.unresolved.add(raw);
    return;
  }
  if (resolved.nullDevice) return;
  const realTarget = realpathOfNearestExisting(resolved.abs);
  if (isAllowedWrite(resolved.abs, realTarget, state)) return;
  state.outside.add(realTarget);
}

function isAllowedWrite(absPath: string, realTarget: string, state: WalkState): boolean {
  if (resolveMemoryRootForPath(absPath) || resolveMemoryRootForPath(realTarget)) return true;
  if (isUnderRoot(realTarget, state.workspaceReal)) return true;
  return isUnderRoot(realTarget, state.tempReal);
}

type ResolvedCommandPath =
  | { ok: true; abs: string; nullDevice: boolean }
  | { ok: false };

function resolveCommandPath(
  raw: string,
  cwd: string,
  cwdKnown: boolean,
  env: NodeJS.ProcessEnv,
): ResolvedCommandPath {
  if (isNullDevice(raw)) return { ok: true, abs: raw, nullDevice: true };
  if (hasCommandSubstitution(raw)) return { ok: false };
  const expanded = expandShellArg(raw, env);
  if (expanded === null) return { ok: false };
  if (isNullDevice(expanded)) return { ok: true, abs: expanded, nullDevice: true };
  const stripped = stripGlob(expanded);
  const relative = !path.isAbsolute(stripped);
  if (relative && !cwdKnown) return { ok: false };
  const abs = relative ? path.resolve(cwd, stripped) : path.resolve(stripped);
  return { ok: true, abs, nullDevice: false };
}

function isGlobalPackageInstall(exe: string, tokens: ShellCommandToken[]): boolean {
  const rest = tokens.slice(1).map((token) => token.value);
  if (exe === 'npm' || exe === 'pnpm') {
    const global = rest.some((token) => token === '-g' || token === '--global');
    const sub = rest.find((token) => !token.startsWith('-'));
    return global && !!sub && GLOBAL_SUBCOMMANDS.has(sub.toLowerCase());
  }
  if (exe === 'yarn') {
    const lower = rest.map((token) => token.toLowerCase());
    const globalAt = lower.indexOf('global');
    if (globalAt < 0) return false;
    const sub = lower[globalAt + 1];
    return sub === 'add' || sub === 'remove';
  }
  return false;
}

function commandBasename(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
}

function isOptionToken(token: string, command: string): boolean {
  if (token.startsWith('-')) return true;
  return CMD_SLASH_COMMANDS.has(command) && /^\/[a-zA-Z][^\\/]*$/.test(token);
}

function isNullDevice(value: string): boolean {
  return /^(?:nul|\/dev\/null|\$null)$/i.test(value.trim());
}

function hasCommandSubstitution(value: string): boolean {
  return /\$\(/.test(value) || value.includes('`');
}

function stripGlob(value: string): string {
  const idx = value.search(/[*?]/);
  if (idx < 0) return value;
  const before = value.slice(0, idx);
  const slash = Math.max(before.lastIndexOf('/'), before.lastIndexOf('\\'));
  if (slash < 0) return '.';
  return before.slice(0, slash) || '.';
}

function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform === 'win32') {
    const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
    if (!key) return undefined;
    return env[key];
  }
  return env[name];
}

function expandShellArg(raw: string, env: NodeJS.ProcessEnv): string | null {
  let missing = false;
  const replaceName = (name: string, homeFallback: boolean): string | null => {
    if (homeFallback && name.toLowerCase() === 'home' && lookupEnv(env, name) === undefined) {
      return os.homedir();
    }
    const value = lookupEnv(env, name);
    if (value === undefined) {
      missing = true;
      return null;
    }
    return value;
  };

  let expanded = raw;
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = os.homedir() + expanded.slice(1);
  }
  expanded = expanded.replace(/%([^%]+)%/g, (all, name: string) => replaceName(name, false) ?? all);
  expanded = expanded.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (all, name: string) => replaceName(name, false) ?? all);
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (all, name: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      missing = true;
      return all;
    }
    return replaceName(name, true) ?? all;
  });
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, name: string) => replaceName(name, true) ?? all);
  if (missing || /\$[A-Za-z_{]/.test(expanded) || /%[^%]+%/.test(expanded)) return null;
  return expanded;
}

function findRedirectTargets(segment: string): string[] {
  const targets: string[] = [];
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < segment.length) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '&' && segment[i + 1] === '>') {
      const word = readRedirectTarget(segment, i + 2);
      if (word) targets.push(word.value);
      i = word?.end ?? i + 2;
      continue;
    }
    if (ch === '>') {
      let j = i + 1;
      if (segment[j] === '>') j++;
      if (segment[j] === '&') {
        const after = segment[j + 1];
        if (after === undefined || /[\d-]/.test(after)) {
          i = j + 1;
          continue;
        }
        j++;
      }
      const word = readRedirectTarget(segment, j);
      if (word) targets.push(word.value);
      i = word?.end ?? j;
      continue;
    }
    i++;
  }
  return targets;
}

function readRedirectTarget(segment: string, start: number): { value: string; end: number } | null {
  let j = start;
  if (segment[j] === '>') j++;
  while (j < segment.length && /\s/.test(segment[j])) j++;
  if (j >= segment.length) return null;
  const quote = segment[j];
  if (quote === '"' || quote === "'") {
    const end = segment.indexOf(quote, j + 1);
    if (end < 0) return { value: segment.slice(j + 1), end: segment.length };
    return { value: segment.slice(j + 1, end), end: end + 1 };
  }
  const wordStart = j;
  while (j < segment.length && !/[\s|&;<>]/.test(segment[j])) j++;
  if (j === wordStart) return null;
  return { value: segment.slice(wordStart, j), end: j };
}
