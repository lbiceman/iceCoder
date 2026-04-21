/**
 * URL 访问工具。
 * 使用 Node.js 内置 fetch API 访问网页 URL，提取文本内容。
 * 支持 HTML 页面自动提取正文、JSON 响应直接返回。
 */

import * as cheerio from 'cheerio';
import type { RegisteredTool } from '../types.js';

/** 默认请求超时（毫秒） */
const DEFAULT_TIMEOUT = 30000;

/** 最大响应体大小（字节）：10MB */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

/** 默认 User-Agent */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 直接抓取 URL 并提取文本内容（供外部调用）。
 */
export async function fetchUrlContent(
  url: string,
  options?: { maxLength?: number; timeout?: number },
): Promise<{ success: boolean; output: string; error?: string }> {
  const maxLength = options?.maxLength || 50000;
  const timeout = options?.timeout || DEFAULT_TIMEOUT;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/json,text/plain,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { success: false, output: '', error: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      return { success: false, output: '', error: `响应体过大: ${contentLength} 字节` };
    }

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    let output: string;

    if (contentType.includes('application/json')) {
      try { output = JSON.stringify(JSON.parse(rawText), null, 2); } catch { output = rawText; }
    } else if (contentType.includes('text/html')) {
      output = extractHtmlText(rawText);
    } else {
      output = rawText;
    }

    if (output.length > maxLength) {
      output = output.slice(0, maxLength) + `\n\n[内容已截断，共 ${rawText.length} 字符]`;
    }

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('abort')) {
      return { success: false, output: '', error: `请求超时 (${timeout}ms): ${url}` };
    }
    return { success: false, output: '', error: `URL 访问失败: ${message}` };
  }
}

/**
 * 创建 URL 访问工具。
 */
export function createUrlFetchTool(): RegisteredTool {
  return {
    definition: {
      name: 'fetch_url',
      description:
        '访问指定 URL 并返回页面内容。支持 HTML（自动提取正文文本）、JSON、纯文本。可自定义请求方法、请求头和请求体。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要访问的 URL' },
          method: {
            type: 'string',
            description: 'HTTP 方法',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
            default: 'GET',
          },
          headers: {
            type: 'object',
            description: '自定义请求头',
            additionalProperties: { type: 'string' },
          },
          body: { type: 'string', description: '请求体（POST/PUT/PATCH 时使用）' },
          extractText: {
            type: 'boolean',
            description: '对 HTML 响应是否提取纯文本（去除标签），默认 true',
            default: true,
          },
          maxLength: {
            type: 'number',
            description: '返回内容的最大字符数，默认 50000',
            default: 50000,
          },
          timeout: {
            type: 'number',
            description: '请求超时（毫秒），默认 30000',
            default: 30000,
          },
        },
        required: ['url'],
      },
    },
    handler: async (args) => {
      const url = args.url as string;
      const method = (args.method as string) || 'GET';
      const customHeaders = (args.headers as Record<string, string>) || {};
      const body = args.body as string | undefined;
      const extractText = args.extractText !== false;
      const maxLength = (args.maxLength as number) || 50000;
      const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;

      try {
        // 构建请求
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const headers: Record<string, string> = {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/json,text/plain,*/*',
          ...customHeaders,
        };

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
          redirect: 'follow',
        };

        if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
          fetchOptions.body = body;
          if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
          }
        }

        const response = await fetch(url, fetchOptions);
        clearTimeout(timer);

        if (!response.ok) {
          return {
            success: false,
            output: '',
            error: `HTTP ${response.status} ${response.statusText}`,
          };
        }

        // 检查响应大小
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
          return {
            success: false,
            output: '',
            error: `响应体过大: ${contentLength} 字节（最大 ${MAX_RESPONSE_SIZE} 字节）`,
          };
        }

        const contentType = response.headers.get('content-type') || '';
        const rawText = await response.text();

        let output: string;

        if (contentType.includes('application/json')) {
          // JSON 响应直接返回格式化后的内容
          try {
            const json = JSON.parse(rawText);
            output = JSON.stringify(json, null, 2);
          } catch {
            output = rawText;
          }
        } else if (contentType.includes('text/html') && extractText) {
          // HTML 响应提取正文文本
          output = extractHtmlText(rawText);
        } else {
          output = rawText;
        }

        // 截断过长内容
        if (output.length > maxLength) {
          output = output.slice(0, maxLength) + `\n\n[内容已截断，共 ${rawText.length} 字符]`;
        }

        return {
          success: true,
          output: `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${output}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('abort')) {
          return { success: false, output: '', error: `请求超时 (${timeout}ms): ${url}` };
        }
        return { success: false, output: '', error: `URL 访问失败: ${message}` };
      }
    },
  };
}

/**
 * 从 HTML 中提取正文文本。
 */
function extractHtmlText(html: string): string {
  const $ = cheerio.load(html);

  // 移除脚本、样式、导航等非内容元素
  $('script, style, nav, header, footer, aside, iframe, noscript').remove();

  const lines: string[] = [];

  // 提取标题
  const title = $('title').text().trim();
  if (title) {
    lines.push(`标题: ${title}\n`);
  }

  // 提取结构化内容
  $('body')
    .find('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote')
    .each((_i, el) => {
      const text = $(el).text().trim();
      if (!text) return;

      const tag = (el as any).tagName?.toLowerCase() || '';
      if (tag.startsWith('h')) {
        const level = parseInt(tag[1]) || 1;
        lines.push(`${'#'.repeat(level)} ${text}`);
      } else if (tag === 'li') {
        lines.push(`- ${text}`);
      } else {
        lines.push(text);
      }
    });

  // 如果结构化提取为空，回退到 body 文本
  if (lines.length <= 1) {
    const bodyText = $('body').text().trim();
    if (bodyText) {
      lines.push(bodyText);
    }
  }

  return lines.join('\n');
}
