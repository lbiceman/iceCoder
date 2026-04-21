/**
 * FileParser 主类，实现策略模式。
 * 根据文件扩展名将文件解析委托给已注册的策略。
 */

import { FileParserStrategy, ParseResult } from './types.js';

export class FileParser {
  private strategies: Map<string, FileParserStrategy> = new Map();

  /**
   * 为策略支持的所有扩展名注册解析策略。
   */
  registerStrategy(strategy: FileParserStrategy): void {
    for (const ext of strategy.supportedExtensions) {
      this.strategies.set(ext.toLowerCase(), strategy);
    }
  }

  /**
   * 根据文件扩展名选择适当的策略来解析文件缓冲区。
   * 对于不支持的格式或空/损坏的文件返回错误结果。
   */
  async parse(buffer: Buffer, filename: string): Promise<ParseResult> {
    const ext = this.extractExtension(filename);

    const strategy = this.strategies.get(ext.toLowerCase());
    if (!strategy) {
      return {
        success: false,
        content: '',
        metadata: { filename, format: ext },
        error: `Unsupported file format: ${ext}`,
      };
    }

    if (buffer.length === 0) {
      return {
        success: false,
        content: '',
        metadata: { filename, format: ext },
        error: 'File is empty or corrupted',
      };
    }

    return strategy.parse(buffer, filename);
  }

  /**
   * 从文件名中提取文件扩展名（不含前导点号）。
   */
  private extractExtension(filename: string): string {
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex === -1 || dotIndex === filename.length - 1) {
      return '';
    }
    return filename.slice(dotIndex + 1).toLowerCase();
  }

  /**
   * 返回所有已注册策略支持的文件扩展名列表（不含前导点号）。
   */
  getSupportedExtensions(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * 使用正则匹配检查文件名的扩展名是否被已注册的策略支持。
   */
  canParse(filename: string): boolean {
    const ext = this.extractExtension(filename);
    if (!ext) return false;
    // 构建正则：精确匹配已注册的扩展名（不区分大小写）
    const pattern = new RegExp(`^(${Array.from(this.strategies.keys()).join('|')})$`, 'i');
    return pattern.test(ext);
  }
}
