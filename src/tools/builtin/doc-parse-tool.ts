/**
 * 文档解析工具集。
 * 提供 DOCX、PPTX、XLSX、ODT、ODP、ODS、PDF、RTF、XMind、HTML、TXT、Markdown、CSV 等格式的解析能力。
 * 复用已有的 FileParser 策略模式，同时扩展更多格式支持。
 * 注意：不支持旧版 .doc 和 .ppt 格式（officeparser 限制）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';
import type { FileParser } from '../../parser/file-parser.js';

/**
 * 创建文档解析工具。
 * @param fileParser - 已配置的 FileParser 实例（包含 HTML、Office、XMind 策略）
 * @param workDir - 工作目录
 */
export function createDocParseTools(fileParser: FileParser, workDir: string): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'parse_document',
        description:
          'Universal document parser. Auto-selects strategy by file extension. Supports: DOCX, PPTX, XLSX, ODT, PDF, RTF, XMind, HTML, TXT, Markdown, CSV, JSON, and more. For deep structured parsing use parse_xlsx_deep / parse_pptx_deep / parse_xmind_deep. For legacy .doc (OLE2 binary) use parse_doc_legacy.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to work directory' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = path.resolve(workDir, args.path);
        const filename = path.basename(filePath);
        const ext = path.extname(filename).toLowerCase().slice(1);

        const textExtensions = ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'toml'];
        if (textExtensions.includes(ext)) {
          const content = await fs.readFile(filePath, 'utf-8');
          return { success: true, output: `File: ${filename}\nFormat: ${ext}\n\n${content}` };
        }

        const buffer = await fs.readFile(filePath);
        const result = await fileParser.parse(buffer, filename);

        if (!result.success) {
          return { success: false, output: '', error: result.error || `Document parse failed: ${filename}` };
        }

        const meta = result.metadata;
        let header = `File: ${meta.filename}\nFormat: ${meta.format}`;
        if (meta.pageCount) header += `\nPages: ${meta.pageCount}`;
        if (meta.nodeCount) header += `\nNodes: ${meta.nodeCount}`;

        return { success: true, output: `${header}\n\n${result.content}` };
      },
    },
  ];
}
