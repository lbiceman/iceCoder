/**
 * Anthropic Provider Adapter - Implements ProviderAdapter for Anthropic Messages API.
 * Supports chat, streaming, tool use, and Anthropic-specific model parameters.
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

/**
 * Configuration for the Anthropic adapter.
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
 * Anthropic Provider Adapter implementing the ProviderAdapter interface.
 * Supports Anthropic Messages API with tool use and streaming.
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
   * Send a chat request to Anthropic Messages API.
   * Extracts system messages as a separate parameter, converts remaining messages
   * to Anthropic format, sends request, and converts response back.
   */
  async chat(messages: UnifiedMessage[], options: LLMOptions): Promise<LLMResponse> {
    try {
      const { systemPrompt, anthropicMessages } = this.convertToAnthropicMessages(messages);
      const params = this.buildRequestParams(systemPrompt, anthropicMessages, options);

      const response = await this.client.messages.create(params);
      return this.convertResponse(response as Anthropic.Message);
    } catch (error) {
      throw this.convertError(error);
    }
  }

  /**
   * Send a streaming chat request to Anthropic Messages API.
   * Handles SSE events: message_start, content_block_delta (text), message_stop.
   * Uses the SDK's high-level stream events: text, inputJson, message.
   */
  async stream(
    messages: UnifiedMessage[],
    callback: StreamCallback,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    try {
      const { systemPrompt, anthropicMessages } = this.convertToAnthropicMessages(messages);
      const params = this.buildRequestParams(systemPrompt, anthropicMessages, options);

      const stream = this.client.messages.stream({ ...params });

      let fullContent = '';

      stream.on('text', (textDelta) => {
        fullContent += textDelta;
        callback(textDelta, false);
      });

      const finalMessage = await stream.finalMessage();

      callback('', true);

      // Extract tool calls from the final message content blocks
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

      return {
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
          provider: this.name,
        },
        finishReason: this.mapStopReason(finalMessage.stop_reason),
      };
    } catch (error) {
      throw this.convertError(error);
    }
  }

  /**
   * Simple token estimation: approximately 4 characters per token.
   */
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  /**
   * Convert UnifiedMessage[] to Anthropic format.
   * Extracts system messages as a separate string parameter.
   * Remaining messages are converted to Anthropic MessageParam format.
   */
  private convertToAnthropicMessages(messages: UnifiedMessage[]): {
    systemPrompt: string | undefined;
    anthropicMessages: Anthropic.MessageParam[];
  } {
    const systemMessages: string[] = [];
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = this.resolveContent(msg.content);
        if (text) {
          systemMessages.push(text);
        }
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        anthropicMessages.push(this.convertSingleMessage(msg));
      } else if (msg.role === 'tool') {
        // Tool results are sent as user messages with tool_result content blocks
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

    return {
      systemPrompt: systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined,
      anthropicMessages,
    };
  }

  /**
   * Convert a single UnifiedMessage to Anthropic MessageParam format.
   */
  private convertSingleMessage(msg: UnifiedMessage): Anthropic.MessageParam {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Assistant message with tool calls
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

    // Regular user or assistant message
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
   */
  private buildRequestParams(
    systemPrompt: string | undefined,
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

    if (systemPrompt) {
      params.system = systemPrompt;
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

    // Handle tools (Tool Use)
    if (options.tools && options.tools.length > 0) {
      params.tools = this.convertToolDefinitions(options.tools);
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

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        provider: this.name,
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
   * Convert Anthropic API errors to a unified error format.
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
