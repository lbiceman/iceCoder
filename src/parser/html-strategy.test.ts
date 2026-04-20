import { describe, it, expect } from 'vitest';
import { HtmlParserStrategy } from './html-strategy.js';

describe('HtmlParserStrategy', () => {
  const strategy = new HtmlParserStrategy();

  describe('supportedExtensions', () => {
    it('should support html and htm extensions', () => {
      expect(strategy.supportedExtensions).toContain('html');
      expect(strategy.supportedExtensions).toContain('htm');
    });
  });

  describe('parse', () => {
    it('should extract headings with # markers', async () => {
      const html = `
        <html><body>
          <h1>Main Title</h1>
          <h2>Subtitle</h2>
          <h3>Section</h3>
        </body></html>
      `;
      const result = await strategy.parse(Buffer.from(html), 'test.html');

      expect(result.success).toBe(true);
      expect(result.content).toContain('# Main Title');
      expect(result.content).toContain('## Subtitle');
      expect(result.content).toContain('### Section');
    });

    it('should extract list items with - prefix', async () => {
      const html = `
        <html><body>
          <ul>
            <li>First item</li>
            <li>Second item</li>
            <li>Third item</li>
          </ul>
        </body></html>
      `;
      const result = await strategy.parse(Buffer.from(html), 'test.html');

      expect(result.success).toBe(true);
      expect(result.content).toContain('- First item');
      expect(result.content).toContain('- Second item');
      expect(result.content).toContain('- Third item');
    });

    it('should extract paragraph text', async () => {
      const html = `
        <html><body>
          <p>This is a paragraph of text.</p>
          <p>Another paragraph here.</p>
        </body></html>
      `;
      const result = await strategy.parse(Buffer.from(html), 'test.html');

      expect(result.success).toBe(true);
      expect(result.content).toContain('This is a paragraph of text.');
      expect(result.content).toContain('Another paragraph here.');
    });

    it('should remove script and style tags', async () => {
      const html = `
        <html><body>
          <script>var x = 1; alert("hello");</script>
          <style>.hidden { display: none; }</style>
          <p>Visible content</p>
        </body></html>
      `;
      const result = await strategy.parse(Buffer.from(html), 'test.html');

      expect(result.success).toBe(true);
      expect(result.content).toContain('Visible content');
      expect(result.content).not.toContain('alert');
      expect(result.content).not.toContain('display: none');
      expect(result.content).not.toContain('var x');
    });

    it('should fallback to body text when no structured elements', async () => {
      const html = `
        <html><body>
          Just some plain text without any tags around it.
        </body></html>
      `;
      const result = await strategy.parse(Buffer.from(html), 'test.html');

      expect(result.success).toBe(true);
      expect(result.content).toContain('Just some plain text without any tags around it.');
    });

    it('should return correct metadata', async () => {
      const html = '<html><body><p>Hello</p></body></html>';
      const result = await strategy.parse(Buffer.from(html), 'page.html');

      expect(result.metadata.filename).toBe('page.html');
      expect(result.metadata.format).toBe('html');
    });
  });
});
