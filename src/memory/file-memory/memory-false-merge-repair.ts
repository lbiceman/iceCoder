/**
 * 修复 Dream 规则层用过粗主题键（lang: / tool: 等）把互不相关事实标成 superseded 的损伤。
 *
 * 旧文件不删，只去掉 superseded-* 并按证据强度恢复 confidence；
 * keeper 上对应的 merged-from / preference-topic 一并清掉。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';

const COARSE_TOPIC_RE = /^(lang|tool|framework|format|test):/i;

export function isCoarseConsolidationTopic(topic: string | null | undefined): boolean {
  if (!topic) return false;
  return COARSE_TOPIC_RE.test(topic.trim());
}

function frontmatterValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

function upsertFrontmatterField(content: string, key: string, value: string): string {
  const fieldPattern = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (fieldPattern.test(content)) {
    return content.replace(fieldPattern, `${key}: ${value}`);
  }
  const confidencePattern = /^(confidence:\s*\S+)\s*$/m;
  if (confidencePattern.test(content)) {
    return content.replace(confidencePattern, `$1\n${key}: ${value}`);
  }
  return content.replace(/^---\s*$/m, `---\n${key}: ${value}`);
}

function removeFrontmatterField(content: string, key: string): string {
  return content.replace(new RegExp(`^${key}:\\s*.*(?:\\r?\\n)?`, 'm'), '');
}

function parseMergedFrom(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(item => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function restoredConfidence(content: string): string {
  const evidence = (frontmatterValue(content, 'evidenceStrength') || '').toLowerCase();
  if (evidence === 'explicit') return '0.85';
  if (evidence === 'repeated') return '0.75';
  return '0.7';
}

export interface CoarseMergeRepairResult {
  restored: string[];
  keepersUpdated: string[];
}

/**
 * 扫描目录，撤销 lang:/tool: 等过粗主题造成的 superseded 标记。
 */
export async function repairCoarseTopicSupersessions(memoryDir: string): Promise<CoarseMergeRepairResult> {
  const restored: string[] = [];
  const keeperRemovals = new Map<string, Set<string>>();

  let names: string[];
  try {
    names = await fs.readdir(memoryDir);
  } catch {
    return { restored, keepersUpdated: [] };
  }

  for (const name of names) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
    const filePath = path.join(memoryDir, name);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const topic = frontmatterValue(content, 'superseded-topic');
    const by = frontmatterValue(content, 'superseded-by');
    if (!by || !isCoarseConsolidationTopic(topic)) continue;

    const keeper = path.basename(by.replace(/['"]/g, '').trim());
    let next = upsertFrontmatterField(content, 'confidence', restoredConfidence(content));
    next = removeFrontmatterField(next, 'superseded-by');
    next = removeFrontmatterField(next, 'superseded-topic');
    next = removeFrontmatterField(next, 'superseded-at');
    if (next !== content) {
      await writeFileAtomic(filePath, next, 'utf-8');
      restored.push(name);
    }
    if (!keeperRemovals.has(keeper)) keeperRemovals.set(keeper, new Set());
    keeperRemovals.get(keeper)!.add(name);
  }

  const keepersUpdated: string[] = [];
  for (const [keeper, victims] of keeperRemovals) {
    const keeperPath = path.join(memoryDir, keeper);
    let content: string;
    try {
      content = await fs.readFile(keeperPath, 'utf-8');
    } catch {
      continue;
    }

    let next = content;
    if (isCoarseConsolidationTopic(frontmatterValue(next, 'preference-topic'))) {
      next = removeFrontmatterField(next, 'preference-topic');
    }
    const mergedItems = parseMergedFrom(frontmatterValue(next, 'merged-from'));
    if (mergedItems.length > 0) {
      const kept = mergedItems.filter(item => !victims.has(item));
      next = kept.length === 0
        ? removeFrontmatterField(next, 'merged-from')
        : upsertFrontmatterField(next, 'merged-from', `[${kept.map(item => `"${item}"`).join(', ')}]`);
    }
    if (next !== content) {
      await writeFileAtomic(keeperPath, next, 'utf-8');
      keepersUpdated.push(keeper);
    }
  }

  return { restored, keepersUpdated };
}
