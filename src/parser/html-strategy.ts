/**
 * 使用 cheerio 的 HTML 解析策略。
 * 从 HTML 文件中提取文本内容和结构信息，
 * 保留标题、列表和段落结构。
 */

import * as cheerio from 'cheerio';
import { Element } from 'domhandler';
import { FileParserStrategy, ParseResult } from './types.js';

export class HtmlParserStrategy implements FileParserStrategy {
  supportedExtensions: string[] = ['html', 'htm'];

  async parse(buffer: Buffer, filename: string): Promise<ParseResult> {
    try {
      const html = buffer.toString('utf-8');
      const $ = cheerio.load(html);

      // 在提取前移除 script 和 style 标签
      $('script').remove();
      $('style').remove();

      const lines: string[] = [];

      $('body').find('*').each((_index, element) => {
        if (!(element instanceof Element)) return;

        const el = $(element);
        const tagName = element.tagName.toLowerCase();

        // 仅处理直接文本内容以避免重复
        if (tagName === 'h1') {
          const text = el.text().trim();
          if (text) lines.push(`# ${text}`);
        } else if (tagName === 'h2') {
          const text = el.text().trim();
          if (text) lines.push(`## ${text}`);
        } else if (tagName === 'h3') {
          const text = el.text().trim();
          if (text) lines.push(`### ${text}`);
        } else if (tagName === 'h4') {
          const text = el.text().trim();
          if (text) lines.push(`#### ${text}`);
        } else if (tagName === 'h5') {
          const text = el.text().trim();
          if (text) lines.push(`##### ${text}`);
        } else if (tagName === 'h6') {
          const text = el.text().trim();
          if (text) lines.push(`###### ${text}`);
        } else if (tagName === 'li') {
          const text = el.clone().children('ul, ol').remove().end().text().trim();
          if (text) lines.push(`- ${text}`);
        } else if (tagName === 'p') {
          const text = el.text().trim();
          if (text) lines.push(text);
        }
      });

      // 如果没有找到结构化元素，回退到 body 文本
      if (lines.length === 0) {
        const bodyText = $('body').text().trim();
        if (bodyText) {
          lines.push(bodyText);
        }
      }

      const content = lines.join('\n');

      return {
        success: true,
        content,
        metadata: {
          filename,
          format: 'html',
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        content: '',
        metadata: {
          filename,
          format: 'html',
        },
        error: `Failed to parse HTML file: ${message}`,
      };
    }
  }
}
