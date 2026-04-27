import { describe, it, expect } from 'vitest';
import { OfficeParserStrategy } from './office-strategy.js';

describe('OfficeParserStrategy', () => {
  const strategy = new OfficeParserStrategy();

  describe('supportedExtensions', () => {
    it('should support docx, pptx, xlsx and other modern Office formats', () => {
      expect(strategy.supportedExtensions).toContain('docx');
      expect(strategy.supportedExtensions).toContain('pptx');
      expect(strategy.supportedExtensions).toContain('xlsx');
      expect(strategy.supportedExtensions).toContain('pdf');
    });
  });

  describe('parse - error handling', () => {
    it('should return error for invalid/corrupted buffer (docx)', async () => {
      const invalidBuffer = Buffer.from('this is not a valid docx file');
      const result = await strategy.parse(invalidBuffer, 'corrupted.docx');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Office 文件解析失败');
      expect(result.metadata.filename).toBe('corrupted.docx');
      expect(result.metadata.format).toBe('docx');
    });

    it('should return error for invalid/corrupted buffer (pptx)', async () => {
      const invalidBuffer = Buffer.from('this is not a valid pptx file');
      const result = await strategy.parse(invalidBuffer, 'corrupted.pptx');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Office 文件解析失败');
      expect(result.metadata.filename).toBe('corrupted.pptx');
      expect(result.metadata.format).toBe('pptx');
    });

    it('should return error for invalid/corrupted buffer (xlsx)', async () => {
      const invalidBuffer = Buffer.from('not a xlsx file content');
      const result = await strategy.parse(invalidBuffer, 'corrupted.xlsx');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Office 文件解析失败');
      expect(result.metadata.filename).toBe('corrupted.xlsx');
      expect(result.metadata.format).toBe('xlsx');
    });

    it('should return error for invalid/corrupted buffer (pdf)', async () => {
      const invalidBuffer = Buffer.from('not a pdf file content');
      const result = await strategy.parse(invalidBuffer, 'corrupted.pdf');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Office 文件解析失败');
      expect(result.metadata.filename).toBe('corrupted.pdf');
      expect(result.metadata.format).toBe('pdf');
    });

    it('should include empty content on error', async () => {
      const invalidBuffer = Buffer.from('garbage data');
      const result = await strategy.parse(invalidBuffer, 'bad.docx');

      expect(result.content).toBe('');
    });
  });
});
