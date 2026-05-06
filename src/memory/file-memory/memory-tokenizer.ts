/**
 * 混合语言分词器（共享模块）。
 *
 * 从 memory-recall.ts / memory-fact-index.ts / harness-memory.ts 中统一抽取。
 *
 * 英文/数字：按空格+标点分词，过滤 ≤1 字符的词。
 * 中文：bigram 滑动窗口（2 字一组）。
 *   "数据库查询优化" → ["数据", "据库", "库查", "查询", "询优", "优化"]
 *
 * bigram 在信息检索中是经典的中文处理方案：
 * - 零依赖，无需词典
 * - 对"匹配"场景够用（查询和记忆描述共享相同 bigram 即可命中）
 * - 会产生无意义片段（如"据库"），但不影响匹配效果
 */

/**
 * 中日韩字符检测正则。
 * CJK Unified Ideographs (4E00-9FFF) + 扩展 A/B + 兼容。
 */
export const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/**
 * 混合语言分词器。
 *
 * @param text - 待分词文本
 * @param options - 分词选项
 * @param options.minWordLength - 英文词最小长度（默认 2，即过滤 ≤1 字符的词）
 * @param options.includeSingleChar - 中文是否包含单字（默认 true，允许"库"匹配"数据库"）
 */
export function tokenize(
  text: string,
  options: { minWordLength?: number; includeSingleChar?: boolean } = {},
): Set<string> {
  const { minWordLength = 2, includeSingleChar = true } = options;
  const tokens = new Set<string>();
  const lower = text.toLowerCase();

  // 英文/数字词：按非字母数字字符分割
  const englishWords = lower.split(/[^a-z0-9]+/).filter(w => w.length >= minWordLength);
  for (const w of englishWords) {
    tokens.add(w);
  }

  // 提取中文字符序列，对每段做 bigram
  const cjkSegments = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g);
  if (cjkSegments) {
    for (const seg of cjkSegments) {
      // 单字也加入（允许单字匹配）
      if (includeSingleChar && seg.length === 1) {
        tokens.add(seg);
      }
      // bigram
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.add(seg.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

/**
 * 提取文本中的实体名（大写开头的连续英文词）。
 *
 * "What did James buy?" → ["James"]
 * "James and Mary went to New York" → ["James", "Mary", "New York"]
 *
 * @returns 实体名集合（已转小写）
 */
export function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g)) {
    const entity = m[1].toLowerCase();
    if (entity.length > 2) entities.add(entity);
  }
  return entities;
}
