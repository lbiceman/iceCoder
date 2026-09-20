/**
 * 用户库真重复去重。
 *
 * Dream 规则合并会保护高置信 / 高召回 user 文件，导致同一偏好两条并存。
 * 本模块只处理 type=user，用原话引号、preference: 标签或高描述相似度判定重复，
 * 合并进 keeper 后把败者归档到 memory-evicted/user-memory（不 unlink）。
 */

import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './atomic-write.js';
import { archiveMemoryFile } from './memory-eviction.js';
import { computeDescriptionSimilarity } from './memory-dedup.js';
import { resolveUserMemoryEvictedDir } from './memory-config.js';
import { removeIndexRows, upsertIndexRow } from './memory-index-maintainer.js';
import { extractBodyFromMarkdown } from './memory-parser.js';
import { scanMemoryFiles } from './memory-scanner.js';
import { getScannerCache } from './memory-scanner-cache.js';
import type { MemoryHeader } from './types.js';

export const USER_DEDUP_SIMILARITY_THRESHOLD = 0.7;
export const USER_QUOTE_MIN_LENGTH = 12;

export type UserDedupReason = 'shared_quote' | 'shared_preference_tag' | 'high_similarity';

export interface UserDedupMerge {
  keeper: string;
  loser: string;
  reason: UserDedupReason;
  similarity: number;
}

export interface UserDedupResult {
  merged: UserDedupMerge[];
  archived: string[];
}

export function extractQuotedUserSpeech(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const patterns = [
    /「([^」]{12,})」/g,
    /『([^』]{12,})』/g,
    /"([^"]{12,})"/g,
    /“([^”]{12,})”/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const quote = match[1].replace(/\s+/g, ' ').trim();
      if (quote.length >= USER_QUOTE_MIN_LENGTH) found.add(quote);
    }
  }
  return [...found];
}

function preferenceTags(tags: string[]): string[] {
  return tags.filter(tag => /^preference:/i.test(tag));
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

function parseMergedFrom(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(item => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function isAlreadySuperseded(content: string): boolean {
  return Boolean(frontmatterValue(content, 'superseded-by'));
}

function mentionsAsSource(content: string, filename: string): boolean {
  if (!filename) return false;
  const merged = parseMergedFrom(frontmatterValue(content, 'merged-from'));
  if (merged.includes(filename)) return true;
  return (
    /consolidated from/i.test(content) && content.includes(filename)
  ) || new RegExp(`merged from\\s+${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(content);
}

export function classifyUserMemoryDuplicate(
  a: MemoryHeader,
  b: MemoryHeader,
  textA: string,
  textB: string,
): { duplicate: boolean; reason: UserDedupReason | null; similarity: number } {
  if (a.filename === b.filename || a.type !== 'user' || b.type !== 'user') {
    return { duplicate: false, reason: null, similarity: 0 };
  }

  const similarity = computeDescriptionSimilarity(a, b);
  const quotesA = extractQuotedUserSpeech(textA);
  const quotesB = new Set(extractQuotedUserSpeech(textB));
  if (quotesA.some(quote => quotesB.has(quote))) {
    return { duplicate: true, reason: 'shared_quote', similarity: Math.max(similarity, 0.9) };
  }

  const sharedPref = preferenceTags(a.tags).some(tag =>
    b.tags.some(other => other.toLowerCase() === tag.toLowerCase()),
  );
  if (sharedPref) {
    return { duplicate: true, reason: 'shared_preference_tag', similarity: Math.max(similarity, 0.75) };
  }

  if (similarity >= USER_DEDUP_SIMILARITY_THRESHOLD) {
    return { duplicate: true, reason: 'high_similarity', similarity };
  }
  return { duplicate: false, reason: null, similarity };
}

export function pickUserDedupKeeper(
  a: MemoryHeader,
  b: MemoryHeader,
  contentA: string,
  contentB: string,
): { keeper: MemoryHeader; loser: MemoryHeader } {
  const aMentionsB = mentionsAsSource(contentA, b.filename);
  const bMentionsA = mentionsAsSource(contentB, a.filename);
  if (aMentionsB && !bMentionsA) return { keeper: a, loser: b };
  if (bMentionsA && !aMentionsB) return { keeper: b, loser: a };

  if (a.recallCount !== b.recallCount) {
    return a.recallCount > b.recallCount
      ? { keeper: a, loser: b }
      : { keeper: b, loser: a };
  }
  if (a.confidence !== b.confidence) {
    return a.confidence > b.confidence
      ? { keeper: a, loser: b }
      : { keeper: b, loser: a };
  }
  if (a.createdMs !== b.createdMs) {
    return a.createdMs >= b.createdMs
      ? { keeper: a, loser: b }
      : { keeper: b, loser: a };
  }
  return contentA.length >= contentB.length
    ? { keeper: a, loser: b }
    : { keeper: b, loser: a };
}

function uniqueLoserParagraphs(keeperBody: string, loserBody: string): string {
  const keeperNorm = keeperBody.replace(/\s+/g, '');
  return loserBody
    .split('\n')
    .map(part => part.trim())
    .filter(part => {
      const norm = part.replace(/\s+/g, '');
      if (norm.length < 12) return false;
      return !keeperNorm.includes(norm.slice(0, Math.min(24, norm.length)));
    })
    .join('\n');
}

async function mergeLoserIntoKeeper(
  keeper: MemoryHeader,
  loser: MemoryHeader,
  contentA: string,
  contentB: string,
): Promise<string> {
  const mergedAt = new Date().toISOString();
  const existing = parseMergedFrom(frontmatterValue(contentA, 'merged-from'));
  const fromLoser = parseMergedFrom(frontmatterValue(contentB, 'merged-from'));
  const allMerged = [...new Set([...existing, loser.filename, ...fromLoser])];

  let next = contentA;
  if (frontmatterValue(next, 'merged-from')) {
    next = upsertFrontmatterField(
      next,
      'merged-from',
      `[${allMerged.map(name => `"${name}"`).join(', ')}]`,
    );
    next = upsertFrontmatterField(next, 'merged-at', mergedAt);
  } else {
    next = upsertFrontmatterField(
      next,
      'merged-from',
      `[${allMerged.map(name => `"${name}"`).join(', ')}]`,
    );
    next = upsertFrontmatterField(next, 'merged-at', mergedAt);
  }

  const extra = uniqueLoserParagraphs(
    extractBodyFromMarkdown(contentA),
    extractBodyFromMarkdown(contentB),
  );
  if (extra) {
    next += `\n\n<!-- merged from ${loser.filename} at ${mergedAt} -->\n${extra}\n`;
  }

  await writeFileAtomic(keeper.filePath, next, 'utf-8');
  return next;
}

function markLoserSuperseded(content: string, keeperFilename: string): string {
  const at = new Date().toISOString();
  let next = upsertFrontmatterField(content, 'superseded-by', keeperFilename);
  next = upsertFrontmatterField(next, 'superseded-topic', 'user-dedup');
  return upsertFrontmatterField(next, 'superseded-at', at);
}

/**
 * 扫描用户库，合并真重复条并把败者归档。
 * 最多 3 轮，避免 A-B、B-C 链式重复只合掉一对。
 */
export async function dedupeUserMemoryDuplicates(
  userDir: string,
  evictedDir: string = resolveUserMemoryEvictedDir(),
): Promise<UserDedupResult> {
  const result: UserDedupResult = { merged: [], archived: [] };
  for (let pass = 0; pass < 3; pass++) {
    const passResult = await dedupeUserMemoryDuplicatesOnce(userDir, evictedDir);
    result.merged.push(...passResult.merged);
    result.archived.push(...passResult.archived);
    if (passResult.merged.length === 0) break;
  }
  return result;
}

async function dedupeUserMemoryDuplicatesOnce(
  userDir: string,
  evictedDir: string,
): Promise<UserDedupResult> {
  const result: UserDedupResult = { merged: [], archived: [] };
  const memories = (await scanMemoryFiles(userDir, 200)).filter(mem => mem.type === 'user');
  if (memories.length < 2) return result;

  const contents = new Map<string, string>();
  await Promise.all(memories.map(async mem => {
    try {
      contents.set(mem.filename, await fs.readFile(mem.filePath, 'utf-8'));
    } catch {
      // unreadable files are skipped
    }
  }));

  const pairs: Array<{
    a: MemoryHeader;
    b: MemoryHeader;
    reason: UserDedupReason;
    similarity: number;
  }> = [];

  for (let i = 0; i < memories.length; i++) {
    const contentA = contents.get(memories[i].filename);
    if (!contentA || isAlreadySuperseded(contentA)) continue;
    for (let j = i + 1; j < memories.length; j++) {
      const contentB = contents.get(memories[j].filename);
      if (!contentB || isAlreadySuperseded(contentB)) continue;
      const classified = classifyUserMemoryDuplicate(
        memories[i],
        memories[j],
        contentA,
        contentB,
      );
      if (classified.duplicate && classified.reason) {
        pairs.push({
          a: memories[i],
          b: memories[j],
          reason: classified.reason,
          similarity: classified.similarity,
        });
      }
    }
  }

  pairs.sort((left, right) => right.similarity - left.similarity);
  const consumed = new Set<string>();

  for (const pair of pairs) {
    if (consumed.has(pair.a.filename) || consumed.has(pair.b.filename)) continue;
    const contentA = contents.get(pair.a.filename);
    const contentB = contents.get(pair.b.filename);
    if (!contentA || !contentB) continue;
    if (isAlreadySuperseded(contentA) || isAlreadySuperseded(contentB)) continue;

    const { keeper, loser } = pickUserDedupKeeper(pair.a, pair.b, contentA, contentB);
    const keeperContent = keeper.filename === pair.a.filename ? contentA : contentB;
    const loserContent = loser.filename === pair.a.filename ? contentA : contentB;

    try {
      const nextKeeper = await mergeLoserIntoKeeper(keeper, loser, keeperContent, loserContent);
      contents.set(keeper.filename, nextKeeper);

      const marked = markLoserSuperseded(loserContent, keeper.filename);
      await writeFileAtomic(loser.filePath, marked, 'utf-8');

      const archived = await archiveMemoryFile(loser.filePath, evictedDir, `user-dedup → ${keeper.filename}`);
      if (!archived) continue;

      consumed.add(loser.filename);
      result.merged.push({
        keeper: keeper.filename,
        loser: loser.filename,
        reason: pair.reason,
        similarity: pair.similarity,
      });
      result.archived.push(loser.filename);

      await removeIndexRows(userDir, [loser.filename]).catch(() => {});
      await upsertIndexRow(userDir, {
        filename: keeper.filename,
        description: keeper.description,
        type: keeper.type,
      }).catch(() => {});
    } catch (err) {
      console.debug(
        `[memory-user-dedup] merge ${loser.filename} → ${keeper.filename} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (result.archived.length > 0) {
    getScannerCache().invalidate(userDir);
    console.log(
      `[memory-user-dedup] merged ${result.merged.length} pair(s): ${
        result.merged.map(item => `${item.loser} → ${item.keeper}`).join(', ')
      }`,
    );
  }

  return result;
}
