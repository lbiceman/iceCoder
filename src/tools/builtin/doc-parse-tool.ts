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
    // ---- 通用文档解析 ----
    {
      definition: {
        name: 'parse_document',
        description:
          '解析文档文件并提取文本内容。支持格式: HTML, DOCX, PPTX, XLSX, ODT, ODP, ODS, PDF, RTF, XMind, TXT, Markdown, CSV, JSON。自动根据文件扩展名选择解析策略。不支持旧版 .doc/.ppt 格式。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = path.resolve(workDir, args.path);
        const filename = path.basename(filePath);
        const ext = path.extname(filename).toLowerCase().slice(1);

        // 纯文本类型直接读取
        const textExtensions = ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'toml'];
        if (textExtensions.includes(ext)) {
          const content = await fs.readFile(filePath, 'utf-8');
          return {
            success: true,
            output: `文件: ${filename}\n格式: ${ext}\n\n${content}`,
          };
        }

        // 使用 FileParser 策略解析
        const buffer = await fs.readFile(filePath);
        const result = await fileParser.parse(buffer, filename);

        if (!result.success) {
          return {
            success: false,
            output: '',
            error: result.error || `文档解析失败: ${filename}`,
          };
        }

        const meta = result.metadata;
        let header = `文件: ${meta.filename}\n格式: ${meta.format}`;
        if (meta.pageCount) header += `\n页数: ${meta.pageCount}`;
        if (meta.nodeCount) header += `\n节点数: ${meta.nodeCount}`;

        return {
          success: true,
          output: `${header}\n\n${result.content}`,
        };
      },
    },

    // ---- 解析 DOC/DOCX ----
    {
      definition: {
        name: 'parse_doc',
        description: '解析 Word 文档（DOCX）并提取文本内容。注意：不支持旧版 .doc 格式。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'DOCX 文件路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = path.resolve(workDir, args.path);
        const filename = path.basename(filePath);
        const buffer = await fs.readFile(filePath);
        const result = await fileParser.parse(buffer, filename);

        if (!result.success) {
          return { success: false, output: '', error: result.error || 'DOC 解析失败' };
        }
        return { success: true, output: result.content };
      },
    },

    // ---- 解析 PPT/PPTX ----
    {
      definition: {
        name: 'parse_ppt',
        description: '解析 PowerPoint 演示文稿（PPTX）并提取文本内容和幻灯片结构。注意：不支持旧版 .ppt 格式，请使用 parse_pptx_deep 工具。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'PPTX 文件路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = path.resolve(workDir, args.path);
        const filename = path.basename(filePath);
        const buffer = await fs.readFile(filePath);
        const result = await fileParser.parse(buffer, filename);

        if (!result.success) {
          return { success: false, output: '', error: result.error || 'PPT 解析失败' };
        }

        let output = result.content;
        if (result.metadata.pageCount) {
          output = `幻灯片数量: ${result.metadata.pageCount}\n\n${output}`;
        }
        return { success: true, output };
      },
    },

    // ---- 解析 XMind ----
    {
      definition: {
        name: 'parse_xmind',
        description: '解析 XMind 思维导图文件，提取层级结构化的文本内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'XMind 文件路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = path.resolve(workDir, args.path);
        const filename = path.basename(filePath);
        const buffer = await fs.readFile(filePath);
        const result = await fileParser.parse(buffer, filename);

        if (!result.success) {
          return { success: false, output: '', error: result.error || 'XMind 解析失败' };
        }

        let output = result.content;
        if (result.metadata.nodeCount) {
          output = `节点数量: ${result.metadata.nodeCount}\n\n${output}`;
        }
        return { success: true, output };
      },
    },

    // ---- 解析 HTML ----
    {
      definition: {
        name: 'parse_html',
        description: '解析 HTML 文件，提取结构化文本内容（标题、段落、列表等）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'HTML 文件路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = path.resolve(workDir, args.path);
        const filename = path.basename(filePath);
        const buffer = await fs.readFile(filePath);
        const result = await fileParser.parse(buffer, filename);

        if (!result.success) {
          return { success: false, output: '', error: result.error || 'HTML 解析失败' };
        }
        return { success: true, output: result.content };
      },
    },
  ];
}
