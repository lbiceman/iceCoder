/**
 * XMind file parsing strategy using JSZip.
 * XMind files are ZIP archives containing a content.json file with the mind map structure.
 * Recursively traverses the topic tree to extract hierarchical text with indentation.
 */

import JSZip from 'jszip';
import { FileParserStrategy, ParseResult } from './types.js';

/**
 * Represents a topic node in the XMind content.json structure.
 */
interface XMindTopic {
  title?: string;
  children?: {
    attached?: XMindTopic[];
  };
}

/**
 * Represents a sheet in the XMind content.json structure.
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
   * Recursively traverses a topic node and its children, building indented text lines.
   * Returns the total number of nodes traversed.
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
