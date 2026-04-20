/**
 * Office file parsing strategy using officeparser.
 * Handles DOC, DOCX, PPT, PPTX formats by extracting text content.
 * For presentations (PPT/PPTX), extracts per-slide text and includes page count in metadata.
 */

import { OfficeParser } from 'officeparser';
import { FileParserStrategy, ParseResult } from './types.js';

export class OfficeParserStrategy implements FileParserStrategy {
  supportedExtensions: string[] = ['doc', 'docx', 'ppt', 'pptx'];

  async parse(buffer: Buffer, filename: string): Promise<ParseResult> {
    const ext = this.extractExtension(filename);

    try {
      const ast = await OfficeParser.parseOffice(buffer);

      const isPresentation = ext === 'ppt' || ext === 'pptx';

      let content: string;
      let pageCount: number | undefined;

      if (isPresentation) {
        // For presentations, extract per-slide text
        const slideNodes = ast.content.filter(
          (node) => node.type === 'slide'
        );

        if (slideNodes.length > 0) {
          pageCount = slideNodes.length;
          const slideTexts = slideNodes.map((slide, index) => {
            const slideText = this.extractNodeText(slide);
            return `--- Slide ${index + 1} ---\n${slideText}`;
          });
          content = slideTexts.join('\n\n');
        } else {
          // Fallback: use toText() and estimate page count from content separators
          content = ast.toText();
          pageCount = this.estimateSlideCount(content);
        }
      } else {
        // For documents (DOC/DOCX), extract full text
        content = ast.toText();
      }

      return {
        success: true,
        content,
        metadata: {
          filename,
          format: ext,
          ...(isPresentation && pageCount !== undefined ? { pageCount } : {}),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        content: '',
        metadata: {
          filename,
          format: ext,
        },
        error: `Failed to parse Office file: ${message}`,
      };
    }
  }

  /**
   * Recursively extracts text from a content node and its children.
   */
  private extractNodeText(node: { text?: string; children?: { text?: string; children?: any[] }[] }): string {
    if (node.text) {
      return node.text;
    }

    if (node.children && node.children.length > 0) {
      return node.children
        .map((child) => this.extractNodeText(child))
        .filter((text) => text.length > 0)
        .join('\n');
    }

    return '';
  }

  /**
   * Estimates slide count from plain text content by looking for content patterns.
   * This is a fallback when structured slide nodes are not available.
   */
  private estimateSlideCount(content: string): number {
    // Split by double newlines as a rough slide boundary estimate
    const sections = content.split(/\n{3,}/);
    return Math.max(sections.length, 1);
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
