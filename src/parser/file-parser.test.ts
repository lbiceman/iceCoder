import { describe, it, expect, beforeEach } from 'vitest';
import { FileParser } from './file-parser.js';
import { FileParserStrategy, ParseResult } from './types.js';

/**
 * Mock strategy for testing purposes.
 */
class MockStrategy implements FileParserStrategy {
  supportedExtensions = ['html', 'htm'];

  async parse(buffer: Buffer, filename: string): Promise<ParseResult> {
    return {
      success: true,
      content: buffer.toString('utf-8'),
      metadata: { filename, format: 'html' },
    };
  }
}

describe('FileParser', () => {
  let parser: FileParser;

  beforeEach(() => {
    parser = new FileParser();
  });

  describe('registerStrategy', () => {
    it('should register a strategy for all its supported extensions', async () => {
      const strategy = new MockStrategy();
      parser.registerStrategy(strategy);

      const result = await parser.parse(Buffer.from('hello'), 'test.html');
      expect(result.success).toBe(true);

      const result2 = await parser.parse(Buffer.from('hello'), 'test.htm');
      expect(result2.success).toBe(true);
    });

    it('should handle case-insensitive extension matching', async () => {
      const strategy = new MockStrategy();
      parser.registerStrategy(strategy);

      const result = await parser.parse(Buffer.from('hello'), 'test.HTML');
      expect(result.success).toBe(true);
    });
  });

  describe('parse', () => {
    it('should delegate parsing to the registered strategy', async () => {
      const strategy = new MockStrategy();
      parser.registerStrategy(strategy);

      const content = '<h1>Hello</h1>';
      const result = await parser.parse(Buffer.from(content), 'page.html');

      expect(result.success).toBe(true);
      expect(result.content).toBe(content);
      expect(result.metadata.filename).toBe('page.html');
    });

    it('should return error for unsupported file format', async () => {
      const result = await parser.parse(Buffer.from('data'), 'file.xyz');

      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(result.metadata.filename).toBe('file.xyz');
      expect(result.metadata.format).toBe('xyz');
      expect(result.error).toBe('Unsupported file format: xyz');
    });

    it('should return error for empty buffer', async () => {
      const strategy = new MockStrategy();
      parser.registerStrategy(strategy);

      const result = await parser.parse(Buffer.alloc(0), 'empty.html');

      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(result.metadata.filename).toBe('empty.html');
      expect(result.error).toBe('File is empty or corrupted');
    });

    it('should return error for file with no extension', async () => {
      const result = await parser.parse(Buffer.from('data'), 'noextension');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unsupported file format: ');
    });

    it('should return error for file ending with a dot', async () => {
      const result = await parser.parse(Buffer.from('data'), 'file.');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unsupported file format: ');
    });
  });
});
