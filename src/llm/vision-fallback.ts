/**
 * 图片 payload 被 API 拒绝时的请求层降级：仅从本次 API 请求移除图片，不修改 session 文件。
 * 不做模型能力假设——先原样发送，报错后再 strip 重试。
 */

import type { ContentBlock, UnifiedMessage } from './types.js';
import { isAbortError } from './abort-error.js';

/** 消息历史中是否含图片内容块。 */
export function messagesContainImages(messages: UnifiedMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content)
      && m.content.some((b) => b.type === 'image' && b.imageUrl),
  );
}

/**
 * 将 user 消息中的图片块转为 API 多模态 parts（Chat Completions 格式）。
 * 供 openai-adapter 与 responses-bridge 共用，不在此处做能力判断。
 */
export function userMessageHasImageBlocks(content: string | ContentBlock[]): boolean {
  return Array.isArray(content)
    && content.some((b) => b.type === 'image' && b.imageUrl);
}

/** 从 ContentBlock[] 提取纯文本（不含图片块）。 */
export function extractTextFromContentBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

/** vision 模式下写入 user 文本的 hint；strip 后需移除以免与降级说明矛盾。 */
const VISION_MULTIMODAL_HINT =
  '用户图片已随本条消息一并发送（多模态），请直接分析，无需调用 image_read。';

function removeVisionMultimodalHint(text: string): string {
  if (!text.includes(VISION_MULTIMODAL_HINT)) {
    return text;
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== VISION_MULTIMODAL_HINT)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * API 拒绝图片 payload 后注入的说明：明确当前模型不支持图片识别。
 * 置于用户正文前，避免模型误判为「用户没发图」。
 */
export function buildImageOmittedNotice(imageCount: number): string {
  return `[本条消息用户附带了 ${imageCount} 张图片；当前模型不支持图片识别，图片内容未包含在本次 API 请求中。]`;
}

/** 从 UnifiedMessage 副本中移除图片块，替换为占位文本（不修改原数组）。 */
export function stripImagesFromMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      return msg;
    }
    const hasImage = msg.content.some((b) => b.type === 'image' && b.imageUrl);
    if (!hasImage) {
      return msg;
    }

    const textParts: string[] = [];
    let imageCount = 0;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        imageCount++;
      }
    }
    const body = removeVisionMultimodalHint(textParts.join('\n'));
    const content = imageCount > 0
      ? `${buildImageOmittedNotice(imageCount)}${body ? `\n\n${body}` : ''}`
      : body;
    const { apiSealedContent: _sealed, ...rest } = msg;
    return { ...rest, content };
  });
}

const IMAGE_PAYLOAD_ERROR_PATTERNS = [
  'image',
  'image_url',
  'input_image',
  'vision',
  'multimodal',
  'content.type',
  'content type',
  'invalid content',
  'payload too large',
  'request entity too large',
  '图片',
];

function messageMatchesImagePayloadError(msg: string): boolean {
  return IMAGE_PAYLOAD_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * 判断是否为「含图请求被 API 拒绝」类错误。
 * 与 messagesContainImages 联用：仅在历史含图时触发 strip 重试。
 */
export function isImagePayloadRejectedError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  const anyErr = error as { status?: number; statusCode?: number };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (status === 400 || status === 413 || status === 422) {
    return true;
  }

  return messageMatchesImagePayloadError(msg);
}

/** @deprecated 使用 isImagePayloadRejectedError */
export const isVisionUnsupportedError = isImagePayloadRejectedError;
