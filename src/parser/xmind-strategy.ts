/**
 * 使用 JSZip 的 XMind 文件解析策略。
 * XMind 文件是包含 content.json 文件的 ZIP 归档，其中存储了思维导图结构。
 * 递归遍历主题树以提取带缩进的层次化文本。
 */

import JSZip from 'jszip';
import { FileParserStrategy, ParseResult } from './types.js';

/**
 * 表示 XMind content.json 结构中的主题节点。
 */
interface XMindTopic {
  title?: string;
  children?: {
    attached?: XMindTopic[];
  };
}

/**
 * 表示 XMind content.json 结构中的画布。
 */
interface XMindSheet {
  rootTopic?: XMindTopic;
}

export class XMindParserStrategy implements FileParserStrategy {
  supportedExtensions: string[] = ['xmind'];

  async parse(buffer: Buffer, filename: string): Promise<ParseResult> {
    try {
      const zip = await JSZip.loadAsync(buffer);

      const contentFile = zip.file('content.json');
      if (!contentFile) {
        return {
          success: false,
          content: '',
          metadata: { filename, format: 'xmind' },
          error: 'XMind file does not contain content.json',
        };
      }

      const contentText = await contentFile.async('text');

      let sheets: XMindSheet[];
      try {
        sheets = JSON.parse(contentText);
      } catch {
        return {
          success: false,
          content: '',
          metadata: { filename, format: 'xmind' },
          error: 'Failed to parse content.json: invalid JSON',
        };
      }

      if (!Array.isArray(sheets) || sheets.length === 0) {
        return {
          success: false,
          content: '',
          metadata: { filename, format: 'xmind' },
          error: 'XMind content.json contains no sheets',
        };
      }

      let nodeCount = 0;
      const lines: string[] = [];

      for (const sheet of sheets) {
        if (sheet.rootTopic) {
          nodeCount += this.traverseTopic(sheet.rootTopic, 0, lines);
        }
      }

      return {
        success: true,
        content: lines.join('\n'),
        metadata: {
          filename,
          format: 'xmind',
          nodeCount,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        content: '',
        metadata: { filename, format: 'xmind' },
        error: `Failed to parse XMind file: ${message}`,
      };
    }
  }

  /**
   * 递归遍历主题节点及其子节点，构建缩进文本行。
   * 返回遍历的节点总数。
   */
  private traverseTopic(topic: XMindTopic, depth: number, lines: string[]): number {
    const indent = '  '.repeat(depth);
    const title = topic.title || '';
    lines.push(`${indent}${title}`);

    let count = 1;

    const children = topic.children?.attached;
    if (children && Array.isArray(children)) {
      for (const child of children) {
        count += this.traverseTopic(child, depth + 1, lines);
      }
    }

    return count;
  }
}
