/**
 * FileParser main class implementing the strategy pattern.
 * Delegates file parsing to registered strategies based on file extension.
 */

import { FileParserStrategy, ParseResult } from './types.js';

export class FileParser {
  private strategies: Map<string, FileParserStrategy> = new Map();

  /**
   * Registers a parsing strategy for all its supported extensions.
   */
  registerStrategy(strategy: FileParserStrategy): void {
    for (const ext of strategy.supportedExtensions) {
      this.strategies.set(ext.toLowerCase(), strategy);
    }
  }

  /**
   * Parses a file buffer by selecting the appropriate strategy based on file extension.
   * Returns an error result for unsupported formats or empty/corrupted files.
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
   * Extracts the file extension from a filename (without the leading dot).
   */
  private extractExtension(filename: string): string {
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex === -1 || dotIndex === filename.length - 1) {
      return '';
    }
    return filename.slice(dotIndex + 1).toLowerCase();
  }
}
