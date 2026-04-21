/**
 * Office 文件解析策略，使用 officeparser 库
 * 支持 DOCX、PPTX、XLSX、ODT、ODP、ODS、PDF、RTF 格式的文本提取
 * 注意：officeparser 不支持旧版 .doc 和 .ppt 格式
 */

import { parseOffice } from 'officeparser';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileParserStrategy, ParseResult } from './types.js';

export class OfficeParserStrategy implements FileParserStrategy {
  supportedExtensions: string[] = ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'pdf', 'rtf'];

  async parse(buffer: Buffer, filename: string): Promise<ParseResult> {
    const ext = this.extractExtension(filename);

    try {
      // officeparser 需要带扩展名的文件路径才能识别格式
      // 将 buffer 写入临时文件（保留原始扩展名）
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `office-parse-${Date.now()}.${ext}`);
      await fs.writeFile(tempFile, buffer);

      let content: string;
      try {
        // parseOffice 直接返回提取的文本字符串
        content = String(await parseOffice(tempFile));
      } finally {
        // 清理临时文件
        await fs.unlink(tempFile).catch(() => {});
      }

      const isPresentation = ext === 'ppt' || ext === 'pptx';

      return {
        success: true,
        content: content || '',
        metadata: {
          filename,
          format: ext,
          ...(isPresentation ? { pageCount: this.estimateSlideCount(content) } : {}),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        content: '',
        metadata: {
          filename,
          format: ext,
        },
        error: `Office 文件解析失败: ${message}`,
      };
    }
  }

  /**
   * 从文本内容估算幻灯片页数
   */
  private estimateSlideCount(content: string): number {
    const sections = content.split(/\n{3,}/);
    return Math.max(sections.length, 1);
  }

  /**
   * 从文件名提取扩展名（不含点号）
   */
  private extractExtension(filename: string): string {
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex === -1 || dotIndex === filename.length - 1) {
      return '';
    }
    return filename.slice(dotIndex + 1).toLowerCase();
  }
}
