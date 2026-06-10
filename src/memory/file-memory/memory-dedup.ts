/**
 * 记忆去重 & 规则重复合并模块（Phase 2.1 / 2.6 / 2.7 / 3.12）。
 *
 * 职责：
 * 1. Extract 写时描述相似度去重（shadow / merge 模式）
 * 2. 规则重复合并：TF-IDF 描述相似度找候选对，超阈值合并
 * 3. 安全闸：禁止自动删除 feedback、高置信度、高召回记忆
 * 4. merged-from 元数据保留
 */

import { promises as fs } from 'node:fs';
import type { MemoryHeader } from './types.js';
import { scanMemoryFiles } from './memory-scanner.js';

// ══════════════════════════════════════════════════════════════════
// 类型
// ══════════════════════════════════════════════════════════════════

export interface DedupCandidate {
  fileA: MemoryHeader;
  fileB: MemoryHeader;
  similarity: number;
}

export interface ExtractDedupDecision {
  shouldUpdate: boolean;
  existingFile?: MemoryHeader;
  similarity: number;
  wouldMergeInfo?: string;
}

// ══════════════════════════════════════════════════════════════════
// 安全闸（2.6）
// ══════════════════════════════════════════════════════════════════

export function isProtectedFromAutoDelete(header: MemoryHeader): boolean {
  if (header.type === 'feedback') return true;
  if (header.confidence >= 0.9) return true;
  if (header.recallCount >= 3) return true;
  return false;
}

export function isProtectedFromAutoMerge(header: MemoryHeader): boolean {
  return isProtectedFromAutoDelete(header);
}

// ══════════════════════════════════════════════════════════════════
// 描述相似度
// ══════════════════════════════════════════════════════════════════

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function cosineSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aFreq = new Map<string, number>();
  const bFreq = new Map<string, number>();
  for (const w of a) aFreq.set(w, (aFreq.get(w) || 0) + 1);
  for (const w of b) bFreq.set(w, (bFreq.get(w) || 0) + 1);
  let dot = 0, normA2 = 0, normB2 = 0;
  for (const [w, fa] of aFreq) { dot += fa * (bFreq.get(w) || 0); normA2 += fa * fa; }
  for (const fb of bFreq.values()) normB2 += fb * fb;
  const denom = Math.sqrt(normA2) * Math.sqrt(normB2);
  return denom === 0 ? 0 : dot / denom;
}

export function computeDescriptionSimilarity(a: MemoryHeader, b: MemoryHeader): number {
  const nameA = tokenize(a.name || '');
  const nameB = tokenize(b.name || '');
  const descA = tokenize(a.description || '');
  const descB = tokenize(b.description || '');
  const nameSim = cosineSimilarity(nameA, nameB);
  const descSim = cosineSimilarity(descA, descB);
  const tagsA = new Set(a.tags || []);
  const tagsB = new Set(b.tags || []);
  let jaccard = 0;
  if (tagsA.size > 0 || tagsB.size > 0) {
    const intersection = [...tagsA].filter(t => tagsB.has(t)).length;
    const union = new Set([...tagsA, ...tagsB]).size;
    jaccard = union > 0 ? intersection / union : 0;
  }
  const typeBonus = a.type === b.type ? 1.0 : 0;
  return 0.4 * nameSim + 0.35 * descSim + 0.15 * jaccard + 0.1 * typeBonus;
}

// ══════════════════════════════════════════════════════════════════
// Extract 写时去重（2.1）
// ══════════════════════════════════════════════════════════════════

export function checkExtractDedupSync(
  existingFiles: MemoryHeader[],
  newMemory: { filename: string; name?: string; description?: string; type?: string; tags?: string[] },
  threshold: number,
  mode: 'off' | 'shadow' | 'merge',
): ExtractDedupDecision {
  if (mode === 'off' || existingFiles.length === 0) {
    return { shouldUpdate: false, similarity: 0 };
  }

  const sameType = newMemory.type
    ? existingFiles.filter(f => f.type === newMemory.type)
    : existingFiles;

  let bestSim = 0;
  let bestMatch: MemoryHeader | undefined;

  for (const existing of sameType) {
    if (existing.filename === newMemory.filename) continue;

    const newHeader: MemoryHeader = {
      filename: newMemory.filename,
      filePath: '',
      mtimeMs: Date.now(),
      name: newMemory.name || null,
      description: newMemory.description || null,
      type: (newMemory.type as MemoryHeader['type']) || undefined,
      level: 'observation',
      evidenceStrength: 'weak',
      confidence: 0.5,
      recallCount: 0,
      lastRecalledMs: 0,
      createdMs: Date.now(),
      tags: newMemory.tags || [],
      source: undefined,
      contentPreview: '',
      eventDateMs: 0,
    };

    const sim = computeDescriptionSimilarity(existing, newHeader);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = existing;
    }
  }

  const shouldUpdate = mode === 'merge' && bestSim >= threshold;
  const info = bestSim >= threshold
    ? `Extract dedup: "${newMemory.name || newMemory.filename}" similar to "${bestMatch?.filename}" (sim=${bestSim.toFixed(3)}, mode=${mode})`
    : undefined;

  return { shouldUpdate, existingFile: bestMatch, similarity: bestSim, wouldMergeInfo: info };
}

// ══════════════════════════════════════════════════════════════════
// 规则重复合并（3.12）
// ══════════════════════════════════════════════════════════════════

export async function findMergeCandidates(
  memoryDir: string,
  threshold: number,
): Promise<DedupCandidate[]> {
  const memories = await scanMemoryFiles(memoryDir, 200);
  const candidates: DedupCandidate[] = [];

  for (let i = 0; i < memories.length; i++) {
    if (isProtectedFromAutoMerge(memories[i])) continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (isProtectedFromAutoMerge(memories[j])) continue;
      if (memories[i].type !== memories[j].type) continue;
      const sim = computeDescriptionSimilarity(memories[i], memories[j]);
      if (sim >= threshold) {
        candidates.push({ fileA: memories[i], fileB: memories[j], similarity: sim });
      }
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

/**
 * 执行规则合并（merge 模式）。
 * 将 fileB 内容追加到 fileA，保留 merged-from。
 */
export async function performRuleMerge(
  candidate: DedupCandidate,
  mode: 'shadow' | 'merge',
): Promise<{ performed: boolean; mergedFile?: string; deletedFile?: string }> {
  if (mode === 'shadow') {
    console.log(
      `[memory-dedup] shadow: would merge "${candidate.fileB.filename}" into "${candidate.fileA.filename}" (sim=${candidate.similarity.toFixed(3)})`,
    );
    return { performed: false };
  }

  const filePathA = candidate.fileA.filePath;
  const filePathB = candidate.fileB.filePath;

  try {
    const [contentA, contentB] = await Promise.all([
      fs.readFile(filePathA, 'utf-8'),
      fs.readFile(filePathB, 'utf-8'),
    ]);

    const mergedAt = new Date().toISOString();

    // Build merged-from from fileB's existing + fileB itself
    const bMergedMatch = contentB.match(/^merged-from:\s*\[(.+?)\]\s*$/m);
    let bMergedFrom: string[] = [];
    if (bMergedMatch) {
      try { bMergedFrom = JSON.parse(`[${bMergedMatch[1]}]`); } catch { /* ignore */ }
    }
    const aMergedMatch = contentA.match(/^merged-from:\s*\[(.+?)\]\s*$/m);
    let aMergedFrom: string[] = [];
    if (aMergedMatch) {
      try { aMergedFrom = JSON.parse(`[${aMergedMatch[1]}]`); } catch { /* ignore */ }
    }

    const allMerged = [...aMergedFrom, candidate.fileB.filename, ...bMergedFrom];

    const bodyB = contentB.replace(/^---[\s\S]*?---\n?/, '').trim();
    let newContentA = contentA;

    if (aMergedMatch) {
      newContentA = newContentA.replace(
        /^merged-from:\s*\[.+?\]\s*$/m,
        `merged-from: [${allMerged.map(f => `"${f}"`).join(', ')}]`,
      );
    } else {
      newContentA = newContentA.replace(
        /^(confidence:\s*\S+)\s*$/m,
        `$1\nmerged-from: [${allMerged.map(f => `"${f}"`).join(', ')}]\nmerged-at: ${mergedAt}`,
      );
    }

    if (bodyB) {
      newContentA += `\n\n<!-- merged from ${candidate.fileB.filename} at ${mergedAt} -->\n${bodyB}`;
    }

    await fs.writeFile(filePathA, newContentA, 'utf-8');
    await fs.unlink(filePathB);

    return { performed: true, mergedFile: candidate.fileA.filename, deletedFile: candidate.fileB.filename };
  } catch (err) {
    console.error(`[memory-dedup] rule merge failed: ${err instanceof Error ? err.message : err}`);
    return { performed: false };
  }
}
