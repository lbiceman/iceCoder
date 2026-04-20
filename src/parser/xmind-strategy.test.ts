import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { XMindParserStrategy } from './xmind-strategy.js';

/**
 * Helper to create a mock XMind file (zip with content.json).
 */
async function createMockXMindBuffer(contentJson: any): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(contentJson));
  const arrayBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  return Buffer.from(arrayBuffer);
}

/**
 * Helper to create a mock XMind file without content.json.
 */
async function createMockXMindBufferWithoutContent(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ version: '2.0' }));
  const arrayBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  return Buffer.from(arrayBuffer);
}

/**
 * Helper to create a mock XMind file with invalid JSON in content.json.
 */
async function createMockXMindBufferWithInvalidJson(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('content.json', 'this is not valid json {{{');
  const arrayBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  return Buffer.from(arrayBuffer);
}

describe('XMindParserStrategy', () => {
  const strategy = new XMindParserStrategy();

  describe('supportedExtensions', () => {
    it('should support xmind extension', () => {
      expect(strategy.supportedExtensions).toContain('xmind');
    });
  });

  describe('parse', () => {
    it('should extract hierarchical text with indentation', async () => {
      const content = [
        {
          rootTopic: {
            title: 'Root',
            children: {
              attached: [
                {
                  title: 'Child 1',
                  children: {
                    attached: [
                      { title: 'Grandchild 1.1' },
                      { title: 'Grandchild 1.2' },
                    ],
                  },
                },
                { title: 'Child 2' },
              ],
            },
          },
        },
      ];

      const buffer = await createMockXMindBuffer(content);
      const result = await strategy.parse(buffer, 'mindmap.xmind');

      expect(result.success).toBe(true);
      expect(result.content).toContain('Root');
      expect(result.content).toContain('  Child 1');
      expect(result.content).toContain('    Grandchild 1.1');
      expect(result.content).toContain('    Grandchild 1.2');
      expect(result.content).toContain('  Child 2');
    });

    it('should report correct nodeCount in metadata', async () => {
      const content = [
        {
          rootTopic: {
            title: 'Root',
            children: {
              attached: [
                { title: 'Child 1' },
                { title: 'Child 2' },
                { title: 'Child 3' },
              ],
            },
          },
        },
      ];

      const buffer = await createMockXMindBuffer(content);
      const result = await strategy.parse(buffer, 'mindmap.xmind');

      expect(result.success).toBe(true);
      // Root + 3 children = 4 nodes
      expect(result.metadata.nodeCount).toBe(4);
    });

    it('should return error when content.json is missing', async () => {
      const buffer = await createMockXMindBufferWithoutContent();
      const result = await strategy.parse(buffer, 'mindmap.xmind');

      expect(result.success).toBe(false);
      expect(result.error).toContain('content.json');
    });

    it('should return error when content.json has invalid JSON', async () => {
      const buffer = await createMockXMindBufferWithInvalidJson();
      const result = await strategy.parse(buffer, 'mindmap.xmind');

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid JSON');
    });

    it('should return correct metadata format', async () => {
      const content = [
        {
          rootTopic: {
            title: 'Root',
          },
        },
      ];

      const buffer = await createMockXMindBuffer(content);
      const result = await strategy.parse(buffer, 'test.xmind');

      expect(result.metadata.filename).toBe('test.xmind');
      expect(result.metadata.format).toBe('xmind');
    });
  });
});
