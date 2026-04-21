/**
 * XMind 深度解析工具。
 * 基于 JSZip + xml2js 实现，兼容 XMind Zen（content.json）和 Legacy（content.xml）两种格式。
 * 支持备注、标签、链接、标记等丰富信息提取，以及树形文本和 Markdown 两种输出格式。
 * 源自知识库: XMind解析工具-Node
 */

import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

// ---- 类型定义 ----

interface XMindNode {
  title: string;
  children: XMindNode[];
  notes?: string;
  labels?: string[];
  link?: string;
  markers?: string[];
  _detached?: boolean;
}

interface XMindSheet {
  title: string;
  rootTopic: XMindNode | null;
}

// ---- XML 解析 ----

async function parseXml(xmlString: string): Promise<any> {
  return parseStringPromise(xmlString, {
    explicitArray: false,
    ignoreAttrs: false,
    mergeAttrs: false,
  });
}

// ---- Zen 格式解析 (content.json) ----

function parseZenNode(node: any, depth: number, maxDepth: number): XMindNode | null {
  if (!node || depth > maxDepth) return null;

  const result: XMindNode = { title: node.title || '', children: [] };

  if (node.notes) {
    if (node.notes.plain?.content) result.notes = node.notes.plain.content;
    else if (node.notes.html?.content)
      result.notes = node.notes.html.content.replace(/<[^>]+>/g, '');
  }
  if (node.labels && node.labels.length > 0) result.labels = node.labels;
  if (node.href) result.link = node.href;
  if (node.markers && node.markers.length > 0)
    result.markers = node.markers.map((m: any) => m.markerId || m);

  const children = node.children;
  if (children) {
    if (children.attached) {
      for (const child of children.attached) {
        const parsed = parseZenNode(child, depth + 1, maxDepth);
        if (parsed) result.children.push(parsed);
      }
    }
    if (children.detached) {
      for (const child of children.detached) {
        const parsed = parseZenNode(child, depth + 1, maxDepth);
        if (parsed) {
          parsed._detached = true;
          result.children.push(parsed);
        }
      }
    }
  }

  return result;
}

function parseZenFormat(jsonContent: string, maxDepth: number): XMindSheet[] {
  const data = JSON.parse(jsonContent);
  const sheetArray = Array.isArray(data) ? data : [data];
  return sheetArray.map((sheet: any) => ({
    title: sheet.title || '未命名画布',
    rootTopic: sheet.rootTopic ? parseZenNode(sheet.rootTopic, 0, maxDepth) : null,
  }));
}

// ---- Legacy 格式解析 (content.xml) ----

function parseLegacyTopic(topic: any, depth: number, maxDepth: number): XMindNode | null {
  if (!topic || depth > maxDepth) return null;

  const result: XMindNode = { title: '', children: [] };

  if (topic['title'])
    result.title = typeof topic['title'] === 'string' ? topic['title'] : topic['title']._ || '';

  if (topic['notes']) {
    const notes = topic['notes'];
    if (notes['plain'])
      result.notes = typeof notes['plain'] === 'string' ? notes['plain'] : notes['plain']._ || '';
    else if (notes['html']) {
      const html = typeof notes['html'] === 'string' ? notes['html'] : notes['html']._ || '';
      result.notes = html.replace(/<[^>]+>/g, '');
    }
  }

  if (topic['labels']) {
    const labels = topic['labels']['label'];
    if (labels) result.labels = Array.isArray(labels) ? labels : [labels];
  }

  if (topic.$?.['xlink:href']) result.link = topic.$['xlink:href'];

  if (topic['marker-refs']) {
    const refs = topic['marker-refs']['marker-ref'];
    if (refs) {
      const refArray = Array.isArray(refs) ? refs : [refs];
      result.markers = refArray.map((r: any) => r.$?.['marker-id'] || '');
    }
  }

  if (topic['children']) {
    const topics = topic['children']['topics'];
    if (topics) {
      const topicsArray = Array.isArray(topics) ? topics : [topics];
      for (const tg of topicsArray) {
        const subTopics = tg['topic'];
        if (subTopics) {
          const subArray = Array.isArray(subTopics) ? subTopics : [subTopics];
          for (const sub of subArray) {
            const parsed = parseLegacyTopic(sub, depth + 1, maxDepth);
            if (parsed) result.children.push(parsed);
          }
        }
      }
    }
  }

  return result;
}

async function parseLegacyFormat(xmlContent: string, maxDepth: number): Promise<XMindSheet[]> {
  const obj = await parseXml(xmlContent);
  const root = obj['xmap-content'] || obj;
  let sheetList = root['sheet'];
  if (!sheetList) return [];
  if (!Array.isArray(sheetList)) sheetList = [sheetList];

  return sheetList.map((sheet: any) => ({
    title: sheet.$?.name || sheet['title'] || '未命名画布',
    rootTopic: sheet['topic'] ? parseLegacyTopic(sheet['topic'], 0, maxDepth) : null,
  }));
}

// ---- 输出格式化 ----

function formatTreeText(node: XMindNode | null, indent = 0, prefix = ''): string {
  if (!node) return '';
  const lines: string[] = [];
  const indentStr = '  '.repeat(indent);
  const marker = indent === 0 ? '🌟 ' : prefix;

  lines.push(`${indentStr}${marker}${node.title}`);
  if (node.notes) lines.push(`${indentStr}   📝 ${node.notes.replace(/\n/g, `\n${indentStr}   `)}`);
  if (node.labels?.length) lines.push(`${indentStr}   🏷️  ${node.labels.join(', ')}`);
  if (node.link) lines.push(`${indentStr}   🔗 ${node.link}`);

  for (let i = 0; i < node.children.length; i++) {
    const isLast = i === node.children.length - 1;
    lines.push(formatTreeText(node.children[i], indent + 1, isLast ? '└─ ' : '├─ '));
  }

  return lines.join('\n');
}

function formatMarkdown(node: XMindNode | null, level = 1): string {
  if (!node) return '';
  const lines: string[] = [];
  const heading = level <= 6 ? '#'.repeat(level) + ' ' : '  '.repeat(level - 6) + '- ';

  lines.push(`${heading}${node.title}`);
  if (node.notes) {
    lines.push('');
    lines.push(`> ${node.notes.replace(/\n/g, '\n> ')}`);
  }
  if (node.labels?.length) {
    lines.push('');
    lines.push(`标签: ${node.labels.map((l) => '`' + l + '`').join(' ')}`);
  }
  if (node.link) {
    lines.push('');
    lines.push(`链接: [${node.link}](${node.link})`);
  }
  lines.push('');
  for (const child of node.children) lines.push(formatMarkdown(child, level + 1));

  return lines.join('\n');
}

function countNodes(node: XMindNode | null): number {
  if (!node) return 0;
  let count = 1;
  for (const child of node.children) count += countNodes(child);
  return count;
}

// ---- 核心解析函数（直接接收 Buffer，供外部调用） ----

/**
 * 直接从 Buffer 解析 XMind 文件内容。
 * 不做路径校验和扩展名检查，适合已上传文件的场景。
 */
export async function parseXmindBuffer(
  data: Buffer,
  options?: { format?: 'tree' | 'markdown'; maxDepth?: number },
): Promise<{ success: boolean; output: string; error?: string }> {
  const outputFormat = options?.format || 'tree';
  const maxDepth = options?.maxDepth ?? Infinity;

  try {
    const zip = await JSZip.loadAsync(data);

    let sheets: XMindSheet[] = [];
    let detectedFormat = '';

    const contentJson = zip.file('content.json');
    const contentXml = zip.file('content.xml');

    if (contentJson) {
      detectedFormat = 'XMind Zen (JSON)';
      sheets = parseZenFormat(await contentJson.async('string'), maxDepth);
    } else if (contentXml) {
      detectedFormat = 'XMind Legacy (XML)';
      sheets = await parseLegacyFormat(await contentXml.async('string'), maxDepth);
    } else {
      const files: string[] = [];
      zip.forEach((p) => files.push(p));
      return {
        success: false,
        output: '',
        error: `无法识别 XMind 文件格式。ZIP 内容: ${files.join(', ')}`,
      };
    }

    let totalNodes = 0;
    for (const sheet of sheets) {
      totalNodes += countNodes(sheet.rootTopic);
    }

    const parts: string[] = [];
    parts.push(`[XMind 信息] 格式: ${detectedFormat} | 画布数: ${sheets.length} | 总节点数: ${totalNodes}`);
    parts.push('');

    if (outputFormat === 'markdown') {
      for (const sheet of sheets) {
        parts.push(formatMarkdown(sheet.rootTopic));
        parts.push('---');
      }
    } else {
      for (let i = 0; i < sheets.length; i++) {
        parts.push(`========== 画布 ${i + 1}: ${sheets[i].title} ==========`);
        parts.push('');
        parts.push(formatTreeText(sheets[i].rootTopic));
        parts.push('');
      }
    }

    return { success: true, output: parts.join('\n') };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return { success: false, output: '', error: `XMind 解析失败: ${message}` };
  }
}

// ---- 安全路径 ----

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

// ---- 工具导出 ----

/**
 * 创建 XMind 深度解析工具。
 * @param workDir - 工作目录
 */
export function createXmindParseTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'parse_xmind_deep',
      description:
        '深度解析 XMind 思维导图文件。兼容 Zen（JSON）和 Legacy（XML）两种格式，提取节点标题、备注、标签、链接等丰富信息。支持树形文本和 Markdown 两种输出格式。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'XMind 文件路径（相对于工作目录）' },
          format: {
            type: 'string',
            description: '输出格式: tree（树形文本，默认）或 markdown',
            enum: ['tree', 'markdown'],
            default: 'tree',
          },
          maxDepth: {
            type: 'number',
            description: '最大解析层级深度，默认不限制',
          },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const filePath = safePath(args.path, workDir);
      const outputFormat: string = args.format || 'tree';
      const maxDepth: number = args.maxDepth ?? Infinity;

      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.xmind') {
        return { success: false, output: '', error: '仅支持 .xmind 格式文件' };
      }

      try {
        const data = await fs.readFile(filePath);
        const zip = await JSZip.loadAsync(data);

        let sheets: XMindSheet[] = [];
        let detectedFormat = '';

        const contentJson = zip.file('content.json');
        const contentXml = zip.file('content.xml');

        if (contentJson) {
          detectedFormat = 'XMind Zen (JSON)';
          sheets = parseZenFormat(await contentJson.async('string'), maxDepth);
        } else if (contentXml) {
          detectedFormat = 'XMind Legacy (XML)';
          sheets = await parseLegacyFormat(await contentXml.async('string'), maxDepth);
        } else {
          const files: string[] = [];
          zip.forEach((p) => files.push(p));
          return {
            success: false,
            output: '',
            error: `无法识别 XMind 文件格式。ZIP 内容: ${files.join(', ')}`,
          };
        }

        // 统计节点数
        let totalNodes = 0;
        for (const sheet of sheets) {
          totalNodes += countNodes(sheet.rootTopic);
        }

        // 格式化输出
        const parts: string[] = [];
        parts.push(`[XMind 信息] 格式: ${detectedFormat} | 画布数: ${sheets.length} | 总节点数: ${totalNodes}`);
        parts.push('');

        if (outputFormat === 'markdown') {
          for (const sheet of sheets) {
            parts.push(formatMarkdown(sheet.rootTopic));
            parts.push('---');
          }
        } else {
          for (let i = 0; i < sheets.length; i++) {
            parts.push(`========== 画布 ${i + 1}: ${sheets[i].title} ==========`);
            parts.push('');
            parts.push(formatTreeText(sheets[i].rootTopic));
            parts.push('');
          }
        }

        return {
          success: true,
          output: parts.join('\n'),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        return { success: false, output: '', error: `XMind 解析失败: ${message}` };
      }
    },
  };
}
