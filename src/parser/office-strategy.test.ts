import { describe, it, expect } from 'vitest';
import { OfficeParserStrategy } from './office-strategy.js';

describe('OfficeParserStrategy', () => {
  const strategy = new OfficeParserStrategy();

  describe('supportedExtensions', () => {
    it('should support doc, docx, ppt, and pptx extensions', () => {
      expect(strategy.supportedExtensions).toContain('doc');
      expect(strategy.supportedExtensions).toContain('docx');
      expect(strategy.supportedExtensions).toContain('ppt');
      expect(strategy.supportedExtensions).toContain('pptx');
    });
  });

  describe('parse - error handling', () => {
    it('should return error for invalid/corrupted buffer (docx)', async () => {
      const invalidBuffer = Buffer.from('this is not a valid docx file');
      const result = await strategy.parse(invalidBuffer, 'corrupted.docx');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Failed to parse Office file');
      expect(result.metadata.filename).toBe('corrupted.docx');
      expect(result.metadata.format).toBe('docx');
    });

    it('should return error for invalid/corrupted buffer (pptx)', async () => {
      const invalidBuffer = Buffer.from('this is not a valid pptx file');
      const result = await strategy.parse(invalidBuffer, 'corrupted.pptx');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Failed to parse Office file');
      expect(result.metadata.filename).toBe('corrupted.pptx');
      expect(result.metadata.format).toBe('pptx');
    });

    it('should return error for invalid/corrupted buffer (doc)', async () => {
      const invalidBuffer = Buffer.from('not a doc file content');
      const result = await strategy.parse(invalidBuffer, 'corrupted.doc');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Failed to parse Office file');
      expect(result.metadata.filename).toBe('corrupted.doc');
      expect(result.metadata.format).toBe('doc');
    });

    it('should return error for invalid/corrupted buffer (ppt)', async () => {
      const invalidBuffer = Buffer.from('not a ppt file content');
      const result = await strategy.parse(invalidBuffer, 'corrupted.ppt');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Failed to parse Office file');
      expect(result.metadata.filename).toBe('corrupted.ppt');
      expect(result.metadata.format).toBe('ppt');
    });

    it('should include empty content on error', async () => {
      const invalidBuffer = Buffer.from('garbage data');
      const result = await strategy.parse(invalidBuffer, 'bad.docx');

      expect(result.content).toBe('');
    });
  });
});
