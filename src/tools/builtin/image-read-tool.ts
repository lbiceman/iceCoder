/**
 * 图片读取工具。
 * 读取图片文件转为 base64 data URL，构造多模态消息发给 LLM 视觉模型描述内容。
 * 支持 PNG/JPG/GIF/WebP/BMP/SVG 格式。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';
import type { LLMAdapterInterface } from '../../llm/types.js';

/** 支持的图片扩展名 → MIME 类型映射 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

/**
 * 创建图片读取工具。
 * @param workDir - 工作目录
 * @param llmAdapter - LLM 适配器（需要视觉能力）
 */
export function createImageReadTool(
  workDir: string,
  llmAdapter: LLMAdapterInterface,
): RegisteredTool {
  return {
    definition: {
      name: 'image_read',
      // 读取图片文件并用 LLM 视觉能力描述内容。支持 PNG/JPG/GIF/WebP/BMP/SVG。
      description:
        'Read an image file and describe its content using LLM vision. Supports PNG/JPG/GIF/WebP/BMP/SVG. Returns a text description of the image.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Image file path. Use the exact absolute path from the user message (e.g. .../imagesCache/<sessionId>/<uuid>.png). Do NOT use placeholders like user_uploaded_image.',
          },
          prompt: {
            type: 'string',
            description: 'What to ask about the image. Default: describe in detail.',
            default: 'Describe this image in detail.',
          },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const filePath = path.resolve(workDir, args.path);
      const prompt = (args.prompt as string) || 'Describe this image in detail.';

      try {
        // 读取图片文件
        const buffer = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = IMAGE_MIME_TYPES[ext];

        if (!mimeType) {
          return {
            success: false,
            output: '',
            error: `Unsupported image format: ${ext}. Supported: ${Object.keys(IMAGE_MIME_TYPES).join(', ')}`,
          };
        }

        // 转为 base64 data URL
        const base64 = buffer.toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;

        // 构造多模态消息
        const response = await llmAdapter.chat(
          [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image', imageUrl: dataUrl },
              ],
            },
          ],
          { maxTokens: 2048 },
        );

        return {
          success: true,
          output: `Image: ${path.basename(filePath)} (${mimeType}, ${buffer.length} bytes)\n\n${response.content}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ENOENT')) {
          return { success: false, output: '', error: `File not found: ${args.path}` };
        }
        return { success: false, output: '', error: `Image read failed: ${message}` };
      }
    },
  };
}
