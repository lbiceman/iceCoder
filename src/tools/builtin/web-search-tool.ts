/**
 * 网页搜索工具。
 * 通过搜索引擎 HTML/API 搜索互联网内容，返回搜索结果摘要。
 * 默认使用国内 Bing（cn.bing.com）；亦支持 DuckDuckGo、SearXNG（自建）。
 */

import * as cheerio from 'cheerio';
import type { RegisteredTool } from '../types.js';

/** 搜索结果条目 */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 默认搜索引擎 */
const DEFAULT_ENGINE = 'bing_cn';

/** 搜索请求超时（毫秒） */
const SEARCH_TIMEOUT_MS = 15000;

const SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 国内 Bing HTML 搜索（无需 API Key）。
 * 通过解析 cn.bing.com 搜索结果页获取摘要。
 */
async function searchBingCn(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&ensearch=0`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': SEARCH_USER_AGENT,
        Accept: 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseBingCnHtml(html, maxResults);
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/** 从 Bing 国内版 HTML 中提取搜索结果（便于单测） */
export function parseBingCnHtml(html: string, maxResults: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $('#b_results li.b_algo').each((_i, el) => {
    if (results.length >= maxResults) return;

    const titleEl = $(el).find('h2 a');
    const title = titleEl.text().trim();
    const href = titleEl.attr('href') || '';
    const snippet = $(el).find('.b_caption p, .b_lineclamp2, .b_algoSlug').first().text().trim();

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  });

  return results;
}

/**
 * DuckDuckGo HTML 搜索（无需 API Key）。
 * 通过解析 DuckDuckGo HTML 页面获取搜索结果。
 */
async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': SEARCH_USER_AGENT,
        Accept: 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $('.result').each((_i, el) => {
      if (results.length >= maxResults) return;

      const titleEl = $(el).find('.result__title a');
      const snippetEl = $(el).find('.result__snippet');

      const title = titleEl.text().trim();
      let href = titleEl.attr('href') || '';
      const snippet = snippetEl.text().trim();

      // DuckDuckGo 的链接可能是重定向格式
      if (href.includes('uddg=')) {
        try {
          const urlObj = new URL(href, 'https://duckduckgo.com');
          href = urlObj.searchParams.get('uddg') || href;
        } catch {
          // 保持原始 href
        }
      }

      if (title && href) {
        results.push({ title, url: href, snippet });
      }
    });

    return results;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/**
 * SearXNG 搜索（自建实例）。
 */
async function searchSearXNG(
  query: string,
  maxResults: number,
  apiUrl: string,
): Promise<SearchResult[]> {
  const url = `${apiUrl}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as { results?: Array<{ title: string; url: string; content: string }> };
    const results: SearchResult[] = [];

    for (const item of data.results || []) {
      if (results.length >= maxResults) break;
      results.push({
        title: item.title || '',
        url: item.url || '',
        snippet: item.content || '',
      });
    }

    return results;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/**
 * 创建网页搜索工具。
 */
export function createWebSearchTool(): RegisteredTool {
  return {
    definition: {
      name: 'web_search',
      // 搜索互联网。获取页面内容用 fetch_url。
      description:
        'Search the internet. Returns titles, URLs, and snippets. Use fetch_url to get full page content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: {
            type: 'number',
            description: '最大返回结果数，默认 8',
            default: 8,
          },
          engine: {
            type: 'string',
            description: '搜索引擎：bing_cn（默认，国内 Bing）、duckduckgo、searxng（需配置 apiUrl）',
            enum: ['bing_cn', 'duckduckgo', 'searxng'],
            default: DEFAULT_ENGINE,
          },
          apiUrl: {
            type: 'string',
            description: 'SearXNG 实例地址（仅 engine=searxng 时需要，如 http://localhost:8080）',
          },
        },
        required: ['query'],
      },
    },
    handler: async (args) => {
      const query = args.query as string;
      const maxResults = (args.maxResults as number) || 8;
      const engine = (args.engine as string) || DEFAULT_ENGINE;

      try {
        let results: SearchResult[];

        if (engine === 'searxng' && args.apiUrl) {
          results = await searchSearXNG(query, maxResults, args.apiUrl as string);
        } else if (engine === 'duckduckgo') {
          results = await searchDuckDuckGo(query, maxResults);
        } else {
          results = await searchBingCn(query, maxResults);
        }

        if (results.length === 0) {
          return { success: true, output: `搜索 "${query}" 未找到结果。` };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
          )
          .join('\n\n');

        return {
          success: true,
          output: `搜索 "${query}" 找到 ${results.length} 条结果:\n\n${formatted}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `搜索失败: ${message}` };
      }
    },
  };
}
