/**
 * 屏幕问号：把落点周围的一小块截图交给当前模型，要一句短回答。
 * 不进 Harness，不调工具。
 */

import type { LLMAdapterInterface, UnifiedMessage } from '../llm/types.js';

const MAX_IMAGE_CHARS = 1_500_000;
const MAX_ANSWER_CHARS = 180;

export class ScreenPingAskError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ScreenPingAskError';
  }
}

export interface ScreenPingAskInput {
  imageDataUrl: string;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
}

export function buildScreenPingMessages(input: ScreenPingAskInput): UnifiedMessage[] {
  const { anchorX, anchorY, width, height } = input;
  return [
    {
      role: 'system',
      content: '你在看用户屏幕上的一小块截图。用中文回答，只写一两句，不要用列表，不要说「这是一张截图」。',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            `这是以问号落点为中心裁出的 ${width}×${height} 像素画面。`,
            `问号打在图内像素 (${anchorX}, ${anchorY})。`,
            '用户想知道这个位置是什么、能做什么。直接回答。',
          ].join(''),
        },
        { type: 'image', imageUrl: input.imageDataUrl },
      ],
    },
  ];
}

function finiteInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

export function parseScreenPingBody(body: unknown): ScreenPingAskInput {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const image = record.image;
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    throw new ScreenPingAskError('缺少截图', 400);
  }
  if (image.length > MAX_IMAGE_CHARS) {
    throw new ScreenPingAskError('截图太大', 400);
  }
  const width = finiteInt(record.width, 200);
  const height = finiteInt(record.height, 200);
  if (width < 1 || height < 1 || width > 2000 || height > 2000) {
    throw new ScreenPingAskError('截图尺寸无效', 400);
  }
  return {
    imageDataUrl: image,
    width,
    height,
    anchorX: finiteInt(record.anchorX, Math.round(width / 2)),
    anchorY: finiteInt(record.anchorY, Math.round(height / 2)),
  };
}

export function tidyScreenPingAnswer(text: string): string {
  const tidy = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!tidy) throw new ScreenPingAskError('模型没有给出回答', 502);
  if (tidy.length <= MAX_ANSWER_CHARS) return tidy;
  return `${tidy.slice(0, MAX_ANSWER_CHARS)}…`;
}

export async function answerScreenPing(
  llm: LLMAdapterInterface,
  body: unknown,
): Promise<{ text: string }> {
  const input = body && typeof body === 'object' && typeof (body as ScreenPingAskInput).imageDataUrl === 'string'
    ? body as ScreenPingAskInput
    : parseScreenPingBody(body);
  const response = await llm.chat(buildScreenPingMessages(input), {
    temperature: 0.2,
    maxTokens: 1024,
    usageSource: 'image_read',
    skipVisionFallback: true,
    requestTimeoutMs: 40_000,
  });
  return { text: tidyScreenPingAnswer(response.content ?? '') };
}
