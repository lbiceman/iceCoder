/**
 * DOC 文件解析工具。
 * 支持两种 .doc 格式：
 * 1. 真正的 OLE2 二进制 Word 文档 → word-extractor 解析
 * 2. MIME/HTML 伪装的 .doc（如 Confluence 导出）→ 提取 HTML 并去标签
 */

import WordExtractor from 'word-extractor';
import * as cheerio from 'cheerio';
import type { RegisteredTool } from '../types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const extractor = new WordExtractor();

/** OLE2 文件魔数 */
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * 从 MIME multipart 格式中提取 HTML 部分。
 */
function extractHtmlFromMime(text: string): string {
  // 找到 boundary
  const boundaryMatch = text.match(/boundary="?([^"\r\n]+)"?/);
  if (!boundaryMatch) return text;

  const boundary = boundaryMatch[1];
  const parts = text.split(boundary);

  // 找包含 text/html 的部分
  for (const part of parts) {
    if (part.includes('Content-Type: text/html') || part.includes('content-type: text/html')) {
      // 去掉 MIME 头，取正文
      const headerEnd = part.indexOf('\r\n\r\n');
      const altEnd = part.indexOf('\n\n');
      const splitPos = headerEnd !== -1 ? headerEnd + 4 : (altEnd !== -1 ? altEnd + 2 : 0);
      let html = part.slice(splitPos);

      // 处理 quoted-printable 编码
      if (part.includes('quoted-printable')) {
        html = html
          .replace(/=\r?\n/g, '')           // 软换行
          .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }

      return html;
    }
  }

  return text;
}

/**
 * 用 cheerio 从 HTML 中提取纯文本。
 */
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  // 移除脚本和样式
  $('script, style, head').remove();
  // 获取文本
  const text = $('body').text() || $.root().text();
  // 清理多余空白
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 直接从 Buffer 解析 DOC 文件内容。
 * 自动检测格式：OLE2 二进制 → word-extractor，MIME/HTML 文本 → cheerio 提取。
 */
export async function parseDocBuffer(
  data: Buffer,
): Promise<{ success: boolean; output: string; error?: string }> {
  // 检测是否是真正的 OLE2 二进制格式
  const isOle2 = data.length >= 8 && data.slice(0, 8).equals(OLE2_MAGIC);

  if (isOle2) {
    // 真正的 .doc 文件，用 word-extractor
    try {
      const doc = await extractor.extract(data);
      const body = doc.getBody() || '';
      const headers = doc.getHeaders({ includeFooters: false }) || '';
      const footers = doc.getFooters() || '';
      const footnotes = doc.getFootnotes() || '';
      const endnotes = doc.getEndnotes() || '';

      const parts: string[] = [];
      if (headers.trim()) parts.push(`[页眉]\n${headers.trim()}`);
      if (body.trim()) parts.push(body.trim());
      if (footnotes.trim()) parts.push(`[脚注]\n${footnotes.trim()}`);
      if (endnotes.trim()) parts.push(`[尾注]\n${endnotes.trim()}`);
      if (footers.trim()) parts.push(`[页脚]\n${footers.trim()}`);

      const output = parts.join('\n\n');
      if (!output) {
        return { success: false, output: '', error: 'DOC 文件无文本内容' };
      }
      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      return { success: false, output: '', error: `DOC 解析失败: ${message}` };
    }
  }

  // 非 OLE2 → 尝试当作文本/MIME/HTML 处理
  let text: string;
  try {
    text = data.toString('utf-8');
  } catch {
    return { success: false, output: '', error: '无法将文件内容解码为文本' };
  }

  // 检测是否是 MIME 格式（Confluence 导出等）
  if (text.startsWith('Date:') || text.startsWith('MIME-Version:') || text.includes('Content-Type: multipart/')) {
    const html = extractHtmlFromMime(text);
    const extracted = htmlToText(html);
    if (extracted) {
      return { success: true, output: extracted };
    }
    return { success: false, output: '', error: 'MIME 格式文件中未找到可提取的文本' };
  }

  // 检测是否是 HTML
  if (text.includes('<html') || text.includes('<HTML') || text.includes('<!DOCTYPE')) {
    const extracted = htmlToText(text);
    if (extracted) {
      return { success: true, output: extracted };
    }
    return { success: false, output: '', error: 'HTML 文件中未找到可提取的文本' };
  }

  // 纯文本
  const trimmed = text.trim();
  if (trimmed) {
    return { success: true, output: trimmed };
  }

  return { success: false, output: '', error: '文件无可识别的文本内容' };
}

// ---- 安全路径 ----

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/**
 * 创建 DOC 解析工具。
 */
export function createDocExtractTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'parse_doc_deep',
      description:
        '解析 Word 文档（.doc 格式）并提取文本内容。支持 OLE2 二进制格式和 MIME/HTML 伪装格式。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'DOC 文件路径（相对于工作目录）' },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const filePath = safePath(args.path, workDir);
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.doc') {
        return { success: false, output: '', error: '仅支持 .doc 格式文件' };
      }
      const data = await fs.readFile(filePath);
      return parseDocBuffer(data);
    },
  };
}
