/**
 * Anthropic 提供者适配器 - 为 Anthropic Messages API 实现 ProviderAdapter。
 * 支持聊天、流式传输、工具使用、Prompt Caching 和 Anthropic 特定的模型参数。
 *
 * Prompt Caching 策略：
 * - system prompt 标记 cache_control → 跨轮次缓存（节省 90% 输入 token 费用）
 * - tools 列表最后一个工具标记 cache_control → 工具定义缓存
 * - 缓存命中的 token 在 usage 中通过 cache_read_input_tokens 返回
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock as UnifiedContentBlock,
  LLMOptions,
  LLMResponse,
  ProviderAdapter,
  StreamCallback,
  ToolCall,
  ToolDefinition,
  UnifiedMessage,
} from './types.js';
import { estimateStringTokens } from './token-estimator.js';

/** Anthropic cache_control 标记 */
const CACHE_BREAKPOINT = { type: 'ephemeral' as const };

/**
 * Anthropic 适配器的配置。
 */
export interface AnthropicAdapterConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
}

/**
 * Anthropic 提供者适配器，实现 ProviderAdapter 接口。
 * 支持 Anthropic Messages API 的工具使用和流式传输。
 */
export class AnthropicAdapter implements ProviderAdapter {
  public readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;
  private defaultParams: Omit<AnthropicAdapterConfig, 'apiKey' | 'model'>;

  constructor(config: AnthropicAdapterConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
    this.model = config.model;
    const { apiKey, model, ...rest } = config;
    this.defaultParams = rest;
  }

  /**
   * 向 Anthropic Messages API 发送聊天请求。
   * 将系统消息提取为单独的参数，将剩余消息转换为 Anthropic 格式，
   * 发送请求，再将响应转换回来。
   */
  async chat(messages: UnifiedMessage[], options: LLMOptions): Promise<LLMResponse> {
    try {
      const { systemBlocks, anthropicMessages } = this.convertToAnthropicMessages(messages);
      const params = this.buildRequestParams(systemBlocks, anthropicMessages, options);

      const response = await this.client.messages.create(params);
      return this.convertResponse(response as Anthropic.Message);
    } catch (error) {
      throw this.convertError(error);
    }
  }

  /**
   * 向 Anthropic Messages API 发送流式聊天请求。
   * 使用 SDK 的高级流事件：text、inputJson、message。
   */
  async stream(
    messages: UnifiedMessage[],
    callback: StreamCallback,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    try {
      const { systemBlocks, anthropicMessages } = this.convertToAnthropicMessages(messages);
      const params = this.buildRequestParams(systemBlocks, anthropicMessages, options);

      const stream = this.client.messages.stream({ ...params });

      let fullContent = '';

      stream.on('text', (textDelta) => {
        fullContent += textDelta;
        callback(textDelta, false);
      });

      const finalMessage = await stream.finalMessage();

      callback('', true);

      // 从最终消息的内容块中提取工具调用
      const toolCalls: ToolCall[] = [];
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, any>,
          });
        }
      }

      const cacheRead = finalMessage.usage.cache_read_input_tokens ?? 0;
      const cacheCreation = finalMessage.usage.cache_creation_input_tokens ?? 0;
      if (cacheRead > 0 || cacheCreation > 0) {
        console.log(`[Anthropic] stream cache: read=${cacheRead}, creation=${cacheCreation}`);
      }

      return {
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
          provider: this.name,
          cacheReadTokens: cacheRead || undefined,
          cacheCreationTokens: cacheCreation || undefined,
        },
        finishReason: this.mapStopReason(finalMessage.stop_reason),
      };
    } catch (error) {
      throw this.convertError(error);
    }
  }

  /**
   * Token 估算：区分 CJK 和 ASCII 字符。
   */
  async countTokens(text: string): Promise<number> {
    return estimateStringTokens(text);
  }

  /**
   * 将 UnifiedMessage[] 转换为 Anthropic 格式。
   * 将系统消息提取为 TextBlockParam[]（支持 cache_control 标记）。
   * 剩余消息转换为 Anthropic MessageParam 格式。
   */
  private convertToAnthropicMessages(messages: UnifiedMessage[]): {
    systemBlocks: Anthropic.Messages.TextBlockParam[] | undefined;
    anthropicMessages: Anthropic.MessageParam[];
  } {
    const systemTexts: string[] = [];
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = this.resolveContent(msg.content);
        if (text) {
          systemTexts.push(text);
        }
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        anthropicMessages.push(this.convertSingleMessage(msg));
      } else if (msg.role === 'tool') {
        // 工具结果作为包含 tool_result 内容块的用户消息发送
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId || '',
              content: this.resolveContent(msg.content),
            },
          ],
        });
      }
    }

    // 构建 system 参数为 TextBlockParam[]，在最后一个块上标记 cache_control
    let systemBlocks: Anthropic.Messages.TextBlockParam[] | undefined;
    if (systemTexts.length > 0) {
      systemBlocks = systemTexts.map((text, idx) => {
        const block: Anthropic.Messages.TextBlockParam = { type: 'text', text };
        // 在最后一个 system 块上标记缓存断点
        if (idx === systemTexts.length - 1) {
          block.cache_control = CACHE_BREAKPOINT;
        }
        return block;
      });
    }

    return { systemBlocks, anthropicMessages: this.mergeConsecutiveUserMessages(anthropicMessages) };
  }

  /**
   * 合并连续的 user 消息（Anthropic API 要求 user/assistant 严格交替）。
   * 将连续 user 消息的 content 合并为一个数组。
   */
  private mergeConsecutiveUserMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      const prev = result[result.length - 1];
      if (msg.role === 'user' && prev?.role === 'user') {
        // 合并 content：统一转为数组形式
        const prevParts = this.toContentArray(prev.content);
        const currParts = this.toContentArray(msg.content);
        result[result.length - 1] = {
          role: 'user',
          content: [...prevParts, ...currParts],
        };
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  /**
   * 将 Anthropic 消息 content 统一转为 ContentBlockParam 数组。
   */
  private toContentArray(content: Anthropic.MessageParam['content']): Anthropic.ContentBlockParam[] {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
    return content as Anthropic.ContentBlockParam[];
  }

  /**
   * Convert a single UnifiedMessage to Anthropic MessageParam format.
   */
  private convertSingleMessage(msg: UnifiedMessage): Anthropic.MessageParam {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // 带工具调用的助手消息
      const content: Anthropic.ContentBlockParam[] = [];
      const textContent = this.resolveContent(msg.content);
      if (textContent) {
        content.push({ type: 'text', text: textContent });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      return { role: 'assistant', content };
    }

    // 用户消息：检查是否包含图片
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const hasImage = msg.content.some(b => b.type === 'image' && b.imageUrl);
      if (hasImage) {
        const parts: Anthropic.ContentBlockParam[] = [];
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image' && block.imageUrl) {
            // 解析 data URL: data:image/png;base64,xxx
            const match = block.imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (match) {
              parts.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: `image/${match[1]}` as any,
                  data: match[2],
                },
              });
            }
          }
        }
        return { role: 'user', content: parts };
      }
    }

    // 普通用户或助手消息
    const textContent = this.resolveContent(msg.content);
    return {
      role: msg.role as 'user' | 'assistant',
      content: textContent,
    };
  }

  /**
   * Resolve content from string or ContentBlock[] to string.
   */
  private resolveContent(content: string | UnifiedContentBlock[]): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text!)
      .join('\n');
  }

  /**
   * Build request parameters for Anthropic API call.
   * system 参数使用 TextBlockParam[] 格式以支持 cache_control 标记。
   * tools 列表最后一个工具标记 cache_control 以缓存工具定义。
   */
  private buildRequestParams(
    systemBlocks: Anthropic.Messages.TextBlockParam[] | undefined,
    messages: Anthropic.MessageParam[],
    options: LLMOptions,
  ): Anthropic.MessageCreateParams {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens ?? this.defaultParams.maxTokens ?? 4096;

    const params: Record<string, any> = {
      model,
      messages,
      max_tokens: maxTokens,
    };

    // system 参数使用 TextBlockParam[] 格式（已包含 cache_control）
    if (systemBlocks && systemBlocks.length > 0) {
      params.system = systemBlocks;
    }

    // Apply default params
    if (this.defaultParams.temperature !== undefined) {
      params.temperature = this.defaultParams.temperature;
    }
    if (this.defaultParams.topP !== undefined) {
      params.top_p = this.defaultParams.topP;
    }
    if (this.defaultParams.topK !== undefined) {
      params.top_k = this.defaultParams.topK;
    }

    // Override with per-call options
    if (options.temperature !== undefined) {
      params.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      params.top_p = options.topP;
    }
    if (options.topK !== undefined) {
      params.top_k = options.topK;
    }

    // 处理工具（Tool Use）— 最后一个工具标记 cache_control
    if (options.tools && options.tools.length > 0) {
      const tools = this.convertToolDefinitions(options.tools);
      // 在最后一个工具上标记缓存断点，使整个工具列表被缓存
      if (tools.length > 0) {
        tools[tools.length - 1] = {
          ...tools[tools.length - 1],
          cache_control: CACHE_BREAKPOINT,
        };
      }
      params.tools = tools;
    }

    return params as Anthropic.MessageCreateParams;
  }

  /**
   * Convert ToolDefinition[] to Anthropic tools format.
   */
  private convertToolDefinitions(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        ...tool.parameters,
      },
    }));
  }

  /**
   * Convert Anthropic Message response to unified LLMResponse.
   * 提取 cache_read_input_tokens 和 cache_creation_input_tokens 到 usage 中。
   */
  private convertResponse(response: Anthropic.Message): LLMResponse {
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, any>,
        });
      }
    }

    const cacheRead = response.usage.cache_read_input_tokens ?? 0;
    const cacheCreation = response.usage.cache_creation_input_tokens ?? 0;
    if (cacheRead > 0 || cacheCreation > 0) {
      console.log(`[Anthropic] cache: read=${cacheRead}, creation=${cacheCreation}`);
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        provider: this.name,
        cacheReadTokens: cacheRead || undefined,
        cacheCreationTokens: cacheCreation || undefined,
      },
      finishReason: this.mapStopReason(response.stop_reason),
    };
  }

  /**
   * Map Anthropic stop_reason to unified finishReason.
   */
  private mapStopReason(
    reason: Anthropic.Message['stop_reason'],
  ): LLMResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  }

  /**
   * 将 Anthropic API 错误转换为统一错误格式。
   */
  private convertError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      const message = `Anthropic API Error [${error.status}]: ${error.message}`;
      const unifiedError = new Error(message);
      (unifiedError as any).status = error.status;
      (unifiedError as any).type = error.type;
      (unifiedError as any).provider = this.name;
      return unifiedError;
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error(`Anthropic Adapter: Unknown error occurred`);
  }
}
