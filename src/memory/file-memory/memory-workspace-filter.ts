/**
 * 按当前工作区过滤跨项目记忆，避免全局 memory-files 池把 Unity / 周报 / 其它仓库的项目事实注入当前任务。
 *
 * 用户偏好与无项目归属的通用排错（Windows / git / PowerShell）一律保留。
 */

import path from 'node:path';
import type { MemoryHeader } from './types.js';

const GENERIC_FILENAME_PREFIXES = [
  'git-',
  'powershell',
  'cmd-',
  'node-',
  'npm-',
  'wsl-',
  'windows-',
  'regex-',
  'fix-error-',
  'cursor-',
  'mcp-tools',
  'python-pptx',
  'adb-',
];

const PROJECT_KEY_ALIASES: Record<string, string[]> = {
  icecoder: ['icecoder', 'ice-coder'],
  climbingstairs: ['climbingstairs', 'climbing-stairs'],
  mathgame: ['mathgame', 'seesaw'],
  tope: ['tope', 'strong-brain', 'strongbrain'],
  tpln: ['tpln', 'weekly-report', 'weeklyreport'],
  unity: ['unity'],
  android: ['android', 'adb', 'gradle'],
  internationalagent: ['international-agent', 'internationalagent'],
  etp2: ['etp2', 'cocos'],
};

const FILENAME_PROJECT_HINTS: Array<{ prefix: string; key: string }> = [
  { prefix: 'icecoder-', key: 'icecoder' },
  { prefix: 'climbingstairs', key: 'climbingstairs' },
  { prefix: 'mathgame-', key: 'mathgame' },
  { prefix: 'tope-', key: 'tope' },
  { prefix: 'tpln-', key: 'tpln' },
  { prefix: 'weekly-report', key: 'tpln' },
  { prefix: 'unity-', key: 'unity' },
  { prefix: 'android-', key: 'android' },
  { prefix: 'international-agent', key: 'internationalagent' },
  { prefix: 'etp2-', key: 'etp2' },
];

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function expandKey(key: string): string[] {
  const aliases = PROJECT_KEY_ALIASES[key];
  return aliases ? aliases.map(normalizeKey) : [normalizeKey(key)];
}

/** 从工作区路径推断项目键（含别名）。 */
export function inferWorkspaceProjectKeys(workspaceRoot: string | undefined): string[] {
  if (!workspaceRoot?.trim()) return [];
  const base = path.basename(path.resolve(workspaceRoot.trim()));
  const normalized = normalizeKey(base);
  if (!normalized) return [];

  const keys = new Set<string>([normalized]);
  for (const [canon, aliases] of Object.entries(PROJECT_KEY_ALIASES)) {
    if (normalized === canon || aliases.some(a => normalizeKey(a) === normalized || normalized.includes(normalizeKey(a)))) {
      for (const k of expandKey(canon)) keys.add(k);
    }
  }
  return [...keys];
}

/** 从文件名 / tags 提取记忆所属项目键。通用工具记忆返回空数组。 */
export function inferMemoryProjectKeys(memory: Pick<MemoryHeader, 'filename' | 'tags' | 'type'>): string[] {
  const filename = path.basename(memory.filename).toLowerCase();
  if (GENERIC_FILENAME_PREFIXES.some(prefix => filename.startsWith(prefix))) {
    return [];
  }

  const keys = new Set<string>();
  for (const hint of FILENAME_PROJECT_HINTS) {
    if (filename.startsWith(hint.prefix) || filename.includes(hint.prefix)) {
      for (const k of expandKey(hint.key)) keys.add(k);
    }
  }

  for (const tag of memory.tags ?? []) {
    const lower = tag.toLowerCase();
    const projectMatch = lower.match(/^(?:project|game|platform):(.+)$/);
    if (projectMatch?.[1]) {
      const value = normalizeKey(projectMatch[1]);
      if (value === 'unity') {
        for (const k of expandKey('unity')) keys.add(k);
        continue;
      }
      if (value.includes('icecoder')) {
        for (const k of expandKey('icecoder')) keys.add(k);
        continue;
      }
      keys.add(value);
      for (const [canon, aliases] of Object.entries(PROJECT_KEY_ALIASES)) {
        if (value === canon || aliases.some(a => normalizeKey(a) === value)) {
          for (const k of expandKey(canon)) keys.add(k);
        }
      }
    }
    if (lower === 'tool:icecoder' || lower === 'tool:iceCoder'.toLowerCase()) {
      for (const k of expandKey('icecoder')) keys.add(k);
    }
    if (lower === 'organization:tpln') {
      for (const k of expandKey('tpln')) keys.add(k);
    }
  }

  return [...keys];
}

function keysOverlap(memoryKeys: string[], workspaceKeys: string[]): boolean {
  for (const mk of memoryKeys) {
    for (const wk of workspaceKeys) {
      if (mk === wk || mk.includes(wk) || wk.includes(mk)) return true;
    }
  }
  return false;
}

/**
 * 丢掉明确属于其它项目的 project / 项目向 feedback；用户偏好与通用排错保留。
 */
export function filterMemoriesByWorkspace<T extends Pick<MemoryHeader, 'filename' | 'tags' | 'type'>>(
  memories: T[],
  workspaceRoot: string | undefined,
): T[] {
  const workspaceKeys = inferWorkspaceProjectKeys(workspaceRoot);
  if (workspaceKeys.length === 0) return memories;

  return memories.filter(memory => {
    if (memory.type === 'user') return true;
    const memoryKeys = inferMemoryProjectKeys(memory);
    if (memoryKeys.length === 0) return true;
    if (keysOverlap(memoryKeys, workspaceKeys)) return true;
    if (memory.type === 'project' || memory.type === 'feedback') return false;
    return true;
  });
}
