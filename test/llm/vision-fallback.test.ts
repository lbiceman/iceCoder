import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMAdapter } from '../../src/llm/llm-adapter.js';
import type { LLMResponse, ProviderAdapter, StreamCallback, UnifiedMessage } from '../../src/llm/types.js';
import {
  buildImageOmittedNotice,
  isImagePayloadRejectedError,
  isVisionUnsupportedError,
  messagesContainImages,
  stripImagesFromMessages,
} from '../../src/llm/vision-fallback.js';

describe('vision-fallback', () => {
  it('messagesContainImages detects image blocks', () => {
    expect(messagesContainImages([{ role: 'user', content: 'hi' }])).toBe(false);
    expect(
      messagesContainImages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', imageUrl: 'data:image/png;base64,abc' },
          ],
        },
      ]),
    ).toBe(true);
  });

  it('buildImageOmittedNotice states model does not support vision', () => {
    const notice = buildImageOmittedNotice(1);
    expect(notice).toContain('用户附带了 1 张图片');
    expect(notice).toContain('当前模型不支持图片识别');
    expect(notice).toContain('未包含在本次 API 请求中');
  });

  it('stripImagesFromMessages removes conflicting vision hint from body', () => {
    const original: UnifiedMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '这是什么\n\n用户图片已随本条消息一并发送（多模态），请直接分析，无需调用 image_read。',
          },
          { type: 'image', imageUrl: 'data:image/png;base64,abc' },
        ],
      },
    ];
    const stripped = stripImagesFromMessages(original);
    expect(stripped[0].content).toContain('当前模型不支持图片识别');
    expect(stripped[0].content).not.toContain('无需调用 image_read');
    expect(stripped[0].content).toContain('这是什么');
  });

  it('stripImagesFromMessages prepends notice and does not mutate original', () => {
    const original: UnifiedMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', imageUrl: 'data:image/png;base64,abc' },
        ],
      },
    ];
    const stripped = stripImagesFromMessages(original);
    expect(typeof stripped[0].content).toBe('string');
    expect(stripped[0].content).toMatch(/^\[本条消息用户附带了 1 张图片/);
    expect(stripped[0].content).toContain('这是什么');
    expect(Array.isArray(original[0].content)).toBe(true);
  });

  it('stripImagesFromMessages clears apiSealedContent on stripped user messages', () => {
    const original: UnifiedMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image', imageUrl: 'data:image/png;base64,abc' }],
        apiSealedContent: 'stale sealed text',
      },
    ];
    const stripped = stripImagesFromMessages(original);
    expect(stripped[0].apiSealedContent).toBeUndefined();
  });

  it('isImagePayloadRejectedError matches 400/413 and vision keywords', () => {
    const err400 = new Error('Bad Request');
    (err400 as any).status = 400;
    expect(isImagePayloadRejectedError(err400)).toBe(true);
    expect(isVisionUnsupportedError(err400)).toBe(true);

    const err413 = new Error('Payload Too Large');
    (err413 as any).status = 413;
    expect(isImagePayloadRejectedError(err413)).toBe(true);

    const errVision = new Error('Model does not support image input');
    expect(isImagePayloadRejectedError(errVision)).toBe(true);
  });

  it('isImagePayloadRejectedError ignores 401', () => {
    const err401 = new Error('Unauthorized');
    (err401 as any).status = 401;
    expect(isImagePayloadRejectedError(err401)).toBe(false);
  });
});

describe('LLMAdapter vision fallback', () => {
  let adapter: LLMAdapter;
  let mockProvider: ProviderAdapter;

  const messagesWithImage: UnifiedMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '描述图片' },
        { type: 'image', imageUrl: 'data:image/png;base64,abc' },
      ],
    },
  ];

  const successResponse: LLMResponse = {
    content: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
    finishReason: 'stop',
  };

  beforeEach(() => {
    adapter = new LLMAdapter({ maxRetries: 0, baseDelay: 1, maxDelay: 1 });
    mockProvider = {
      name: 'test',
      chat: vi.fn(),
      stream: vi.fn(),
      countTokens: vi.fn().mockResolvedValue(1),
    };
    adapter.registerProvider(mockProvider);
    adapter.setDefaultProvider('test');
  });

  it('chat retries once with stripped messages on 400 when history has images', async () => {
    const apiError = new Error('OpenAI API Error [400]: bad request');
    (apiError as any).status = 400;

    (mockProvider.chat as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(apiError)
      .mockResolvedValueOnce(successResponse);

    const result = await adapter.chat(messagesWithImage);
    expect(result.content).toBe('ok');
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);

    const firstCall = (mockProvider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const secondCall = (mockProvider.chat as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const secondOpts = (mockProvider.chat as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(messagesContainImages(firstCall)).toBe(true);
    expect(messagesContainImages(secondCall)).toBe(false);
    expect(secondCall[0].content).toContain('用户附带了 1 张图片');
    expect(secondOpts.skipVisionFallback).toBe(true);
  });

  it('chat does not strip on 400 when messages have no images', async () => {
    const pairingError = new Error('Invalid tool_calls pairing');
    (pairingError as any).status = 400;
    (mockProvider.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(pairingError);

    await expect(adapter.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('Invalid tool_calls pairing');
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });

  it('chat does not strip on non-rejected errors', async () => {
    const authError = new Error('Unauthorized');
    (authError as any).status = 401;
    (mockProvider.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(authError);

    await expect(adapter.chat(messagesWithImage)).rejects.toThrow('Unauthorized');
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });

  it('chat respects skipVisionFallback', async () => {
    const apiError = new Error('OpenAI API Error [400]: bad request');
    (apiError as any).status = 400;
    (mockProvider.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(apiError);

    await expect(
      adapter.chat(messagesWithImage, { skipVisionFallback: true }),
    ).rejects.toThrow('bad request');
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });

  it('chat throws when strip retry also fails', async () => {
    const apiError = new Error('OpenAI API Error [400]: bad request');
    (apiError as any).status = 400;
    const stillBad = new Error('still bad');

    (mockProvider.chat as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(apiError)
      .mockRejectedValueOnce(stillBad);

    await expect(adapter.chat(messagesWithImage)).rejects.toThrow('still bad');
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
  });

  it('stream retries once with stripped messages before any output', async () => {
    const apiError = new Error('OpenAI API Error [400]: bad request');
    (apiError as any).status = 400;

    (mockProvider.stream as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        throw apiError;
      })
      .mockImplementationOnce(async (_msgs, cb: StreamCallback) => {
        cb('ok', false);
        return successResponse;
      });

    const chunks: string[] = [];
    const result = await adapter.stream(messagesWithImage, (chunk) => {
      if (typeof chunk === 'string' && chunk) chunks.push(chunk);
    });

    expect(result.content).toBe('ok');
    expect(chunks.join('')).toBe('ok');
    expect(mockProvider.stream).toHaveBeenCalledTimes(2);
    const secondCall = (mockProvider.stream as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(messagesContainImages(secondCall)).toBe(false);
  });

  it('stream does not strip after output has started', async () => {
    const apiError = new Error('OpenAI API Error [400]: bad request');
    (apiError as any).status = 400;

    (mockProvider.stream as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_msgs, cb: StreamCallback) => {
        cb('partial', false);
        throw apiError;
      },
    );

    await expect(
      adapter.stream(messagesWithImage, () => {}),
    ).rejects.toThrow('bad request');
    expect(mockProvider.stream).toHaveBeenCalledTimes(1);
  });
});
