/**
 * OpenAI Provider Adapter - Implements ProviderAdapter for OpenAI Chat Completions API.
 * Supports configurable baseURL for OpenAI-compatible APIs (e.g., NVIDIA).
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8
 */

import OpenAI from 'openai';
import type {
  ContentBlock,
  LLMOptions,
  LLMResponse,
  ProviderAdapter,
  StreamCallback,
  ToolCall,
  ToolDefinition,
  UnifiedMessage,
} from './types.js';

/**
 * Configuration for the OpenAI adapter.
 */
export interface OpenAIAdapterConfig {
  apiKey: string;
  baseURL?: string;
  organization?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  [key: string]: any;
}

/**
 * OpenAI Provider Adapter implementing the ProviderAdapter interface.
 * Supports OpenAI Chat Completions API and OpenAI-compatible APIs (e.g., NVIDIA).
 */
export class OpenAIAdapter implements ProviderAdapter {
  public readonly name = 'openai';
  private client: OpenAI;
  private model: string;
  private defaultParams: Omit<OpenAIAdapterConfig, 'apiKey' | 'baseURL' | 'organization' | 'model'>;

  constructor(config: OpenAIAdapterConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      organization: config.organization,
    });
    this.model = config.model;
    const { apiKey, baseURL, organization, model, ...rest } = config;
    this.defaultParams = rest;
  }

  /**
   * Send a chat request to OpenAI Chat Completions API.
   * Converts UnifiedMessage[] to OpenAI format, sends request, converts response back.
   */
  async chat(messages: UnifiedMessage[], options: LLMOptions): Promise<LLMResponse> {
    try {
      const openaiMessages = this.convertToOpenAIMessages(messages);
      const params = this.buildRequestParams(openaiMessages, options, false);

      const response = await this.client.chat.completions.create(params);
      return this.convertResponse(response as OpenAI.ChatCompletion);
    } catch (error) {
      throw this.convertError(error);
    }
  }

  /**
   * Send a streaming chat request to OpenAI Chat Completions API.
   * Handles both delta.content and delta.reasoning_content fields.
   */
  async stream(
    messages: UnifiedMessage[],
    callback: StreamCallback,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    try {
      const openaiMessages = this.convertToOpenAIMessages(messages);
      const params = this.buildRequestParams(openaiMessages, options, true);

      const stream = await this.client.chat.completions.create({
        ...params,
        stream: true,
      });

      let fullContent = '';
      let reasoningContent = '';
      let finishReason: LLMResponse['finishReason'] = 'stop';
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const chunkFinishReason = chunk.choices?.[0]?.finish_reason;

        if (delta) {
          // Handle regular content
          if (delta.content) {
            fullContent += delta.content;
            callback(delta.content, false);
          }

          // Handle reasoning_content for thinking models (e.g., NVIDIA glm-5.1)
          const deltaAny = delta as any;
          if (deltaAny.reasoning_content) {
            reasoningContent += deltaAny.reasoning_content;
            callback(deltaAny.reasoning_content, false);
          }

          // Handle tool calls in streaming
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index;
              if (!toolCalls.has(index)) {
                toolCalls.set(index, {
                  id: toolCall.id || '',
                  name: toolCall.function?.name || '',
                  arguments: '',
                });
              }
              const existing = toolCalls.get(index)!;
              if (toolCall.id) existing.id = toolCall.id;
              if (toolCall.function?.name) existing.name = toolCall.function.name;
              if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
            }
          }
        }

        if (chunkFinishReason) {
          finishReason = this.mapFinishReason(chunkFinishReason);
        }

        // Extract usage from the final chunk if available
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      callback('', true);

      const combinedContent = reasoningContent
        ? `${reasoningContent}\n\n${fullContent}`
        : fullContent;

      const parsedToolCalls = this.parseStreamToolCalls(toolCalls);

      return {
        content: combinedContent,
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: promptTokens + completionTokens,
          provider: this.name,
        },
        finishReason,
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
   * Convert UnifiedMessage[] to OpenAI ChatCompletionMessageParam[].
   */
  private convertToOpenAIMessages(
    messages: UnifiedMessage[],
  ): OpenAI.ChatCompletionMessageParam[] {
    return messages.map((msg) => this.convertSingleMessage(msg));
  }

  /**
   * Convert a single UnifiedMessage to OpenAI message format.
   */
  private convertSingleMessage(msg: UnifiedMessage): OpenAI.ChatCompletionMessageParam {
    const content = this.resolveContent(msg.content);

    switch (msg.role) {
      case 'system':
        return { role: 'system', content };
      case 'user':
        return { role: 'user', content };
      case 'assistant': {
        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        return assistantMsg;
      }
      case 'tool':
        return {
          role: 'tool',
          content,
          tool_call_id: msg.toolCallId || '',
        };
      default:
        return { role: 'user', content };
    }
  }

  /**
   * Resolve content from string or ContentBlock[] to string.
   */
  private resolveContent(content: string | ContentBlock[]): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text!)
      .join('\n');
  }

  /**
   * Build request parameters for OpenAI API call.
   */
  private buildRequestParams(
    messages: OpenAI.ChatCompletionMessageParam[],
    options: LLMOptions,
    stream: boolean,
  ): OpenAI.ChatCompletionCreateParams {
    const model = options.model || this.model;

    const params: Record<string, any> = {
      model,
      messages,
      stream,
    };

    // Apply default params
    if (this.defaultParams.temperature !== undefined) {
      params.temperature = this.defaultParams.temperature;
    }
    if (this.defaultParams.maxTokens !== undefined) {
      params.max_tokens = this.defaultParams.maxTokens;
    }
    if (this.defaultParams.topP !== undefined) {
      params.top_p = this.defaultParams.topP;
    }
    if (this.defaultParams.frequencyPenalty !== undefined) {
      params.frequency_penalty = this.defaultParams.frequencyPenalty;
    }
    if (this.defaultParams.presencePenalty !== undefined) {
      params.presence_penalty = this.defaultParams.presencePenalty;
    }

    // Override with per-call options
    if (options.temperature !== undefined) {
      params.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      params.max_tokens = options.maxTokens;
    }
    if (options.topP !== undefined) {
      params.top_p = options.topP;
    }
    if (options.frequencyPenalty !== undefined) {
      params.frequency_penalty = options.frequencyPenalty;
    }
    if (options.presencePenalty !== undefined) {
      params.presence_penalty = options.presencePenalty;
    }

    // Handle tools (Function Calling)
    if (options.tools && options.tools.length > 0) {
      params.tools = this.convertToolDefinitions(options.tools);
    }

    // Pass-through provider-specific parameters (e.g., chat_template_kwargs for NVIDIA)
    if (options.chatTemplateKwargs) {
      params.chat_template_kwargs = options.chatTemplateKwargs;
    }

    // Include stream_options for usage in streaming
    if (stream) {
      params.stream_options = { include_usage: true };
    }

    return params as OpenAI.ChatCompletionCreateParams;
  }

  /**
   * Convert ToolDefinition[] to OpenAI tools format.
   */
  private convertToolDefinitions(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Convert OpenAI ChatCompletion response to unified LLMResponse.
   */
  private convertResponse(response: OpenAI.ChatCompletion): LLMResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    let content = message?.content || '';

    // Handle reasoning_content if present (for thinking models)
    const messageAny = message as any;
    if (messageAny?.reasoning_content) {
      content = `${messageAny.reasoning_content}\n\n${content}`;
    }

    const toolCalls = this.parseToolCalls(message?.tool_calls);

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        provider: this.name,
      },
      finishReason: this.mapFinishReason(choice?.finish_reason),
    };
  }

  /**
   * Parse tool_calls from OpenAI response message.
   */
  private parseToolCalls(
    toolCalls?: OpenAI.ChatCompletionMessageToolCall[],
  ): ToolCall[] {
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    return toolCalls
      .filter((tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.safeParseJSON(tc.function.arguments),
      }));
  }

  /**
   * Parse accumulated tool calls from streaming.
   */
  private parseStreamToolCalls(
    toolCalls: Map<number, { id: string; name: string; arguments: string }>,
  ): ToolCall[] {
    const result: ToolCall[] = [];
    for (const [, tc] of toolCalls) {
      result.push({
        id: tc.id,
        name: tc.name,
        arguments: this.safeParseJSON(tc.arguments),
      });
    }
    return result;
  }

  /**
   * Safely parse JSON string to object.
   */
  private safeParseJSON(jsonStr: string): Record<string, any> {
    try {
      return JSON.parse(jsonStr);
    } catch {
      return { raw: jsonStr };
    }
  }

  /**
   * Map OpenAI finish_reason to unified finishReason.
   */
  private mapFinishReason(
    reason: string | null | undefined,
  ): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'length':
        return 'length';
      default:
        return 'stop';
    }
  }

  /**
   * Convert OpenAI API errors to a unified error format.
   */
  private convertError(error: unknown): Error {
    if (error instanceof OpenAI.APIError) {
      const message = `OpenAI API Error [${error.status}]: ${error.message}`;
      const unifiedError = new Error(message);
      (unifiedError as any).status = error.status;
      (unifiedError as any).code = error.code;
      (unifiedError as any).provider = this.name;
      return unifiedError;
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error(`OpenAI Adapter: Unknown error occurred`);
  }
}
