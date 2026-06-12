/**
 * 写后读 Gate 豁免目录配置：全局 config.json + 工作区 .icecoder.json 合并。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readMainConfigFile } from '../config/main-config-supervisor-mode.js';

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

export const WORKSPACE_ICECODER_CONFIG_NAMES = ['.icecoder.json', 'icecoder.json'] as const;

/** 记忆 / 会话笔记目录：不参与写后读 Gate，避免验收续跑把模型拉回循环 */
export const DEFAULT_VERIFICATION_EXEMPT_PREFIXES = [
  'data/session-notes',
  'data/memory-files',
  'data/user-memory',
  'data/sessions',
  '.icecoder/session-notes',
] as const;

let runtimeExemptPrefixes: string[] = [];
let runtimeWorkspaceRoot: string | undefined;

/** 将配置项规范为工作区相对目录前缀（小写、正斜杠、无 ..）。 */
export function normalizeVerificationExemptPrefix(raw: string): string | null {
  let s = raw.trim().replace(/\\/g, '/').toLowerCase();
  if (!s) return null;
  s = s.replace(/^\.\/+/, '');
  s = s.replace(/^\/+/, '');
  s = s.replace(/\/+$/, '');
  if (!s || s === '.' || s.includes('..')) return null;
  return s;
}

export function normalizeVerificationExemptPrefixes(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const norm = normalizeVerificationExemptPrefix(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** 路径是否位于某豁免前缀之下（前缀本身或其子路径）。 */
export function isUnderExemptDirPrefix(normPath: string, prefix: string): boolean {
  if (!prefix) return false;
  if (normPath === prefix) return true;
  return normPath.startsWith(`${prefix}/`);
}

/** 绝对路径转为相对工作区路径；无法 relativize 时返回原 norm。 */
export function toWorkspaceRelativePath(filePath: string, workspaceRoot?: string): string {
  const norm = normalizePath(filePath);
  if (!workspaceRoot?.trim()) return norm;
  const ws = normalizePath(workspaceRoot).replace(/\/+$/, '');
  if (!ws) return norm;
  if (norm === ws) return '';
  const prefix = `${ws}/`;
  if (norm.startsWith(prefix)) return norm.slice(prefix.length);
  return norm;
}

export function getVerificationExemptDirPrefixes(): readonly string[] {
  return runtimeExemptPrefixes;
}

export function getVerificationExemptWorkspaceRoot(): string | undefined {
  return runtimeWorkspaceRoot;
}

/** 供 Harness 每轮 run 注入；测试可调用 resetVerificationExemptRuntime 清理。 */
export function setVerificationExemptRuntime(options: {
  workspaceRoot?: string;
  prefixes: readonly string[];
}): void {
  runtimeWorkspaceRoot = options.workspaceRoot?.trim() || undefined;
  runtimeExemptPrefixes = normalizeVerificationExemptPrefixes(options.prefixes);
}

export function resetVerificationExemptRuntime(): void {
  runtimeExemptPrefixes = [];
  runtimeWorkspaceRoot = undefined;
}

export function isProjectCustomExemptPath(filePath: string): boolean {
  if (runtimeExemptPrefixes.length === 0) return false;
  const rel = toWorkspaceRelativePath(filePath, runtimeWorkspaceRoot);
  const abs = normalizePath(filePath);
  return runtimeExemptPrefixes.some(
    prefix => isUnderExemptDirPrefix(rel, prefix) || isUnderExemptDirPrefix(abs, prefix),
  );
}

export async function readWorkspaceVerificationExemptDirs(workspaceRoot: string): Promise<string[]> {
  for (const name of WORKSPACE_ICECODER_CONFIG_NAMES) {
    const configPath = path.join(workspaceRoot, name);
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as { verificationExemptDirs?: unknown };
      if (!Array.isArray(parsed.verificationExemptDirs)) continue;
      return parsed.verificationExemptDirs.filter((v): v is string => typeof v === 'string');
    } catch {
      continue;
    }
  }
  return [];
}

export async function readVerificationExemptDirsFromMainConfig(configPath: string): Promise<string[]> {
  const config = await readMainConfigFile(configPath);
  const dirs = config.verificationExemptDirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((v): v is string => typeof v === 'string');
}

/** 合并全局 + 工作区 + 可选 env（逗号分隔）目录前缀。 */
export async function resolveVerificationExemptDirPrefixes(options: {
  workspaceRoot?: string;
  globalDirs?: string[];
  mainConfigPath?: string;
  envDirs?: string;
}): Promise<string[]> {
  const merged: string[] = [
    ...DEFAULT_VERIFICATION_EXEMPT_PREFIXES,
    ...(options.globalDirs ?? []),
  ];

  if (options.mainConfigPath) {
    merged.push(...await readVerificationExemptDirsFromMainConfig(options.mainConfigPath));
  }

  if (options.workspaceRoot?.trim()) {
    merged.push(...await readWorkspaceVerificationExemptDirs(options.workspaceRoot));
  }

  const envRaw = options.envDirs ?? process.env.ICE_VERIFICATION_EXEMPT_DIRS;
  if (envRaw?.trim()) {
    merged.push(...envRaw.split(',').map(s => s.trim()).filter(Boolean));
  }

  return normalizeVerificationExemptPrefixes(merged);
}
