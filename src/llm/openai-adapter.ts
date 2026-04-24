/**
 * OpenAI 提供者适配器 - 为 OpenAI Chat Completions API 实现 ProviderAdapter。
 * 支持可配置的 baseURL 以兼容 OpenAI 兼容 API（如 NVIDIA）。
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
 * OpenAI 适配器的配置。
 */
export interface OpenAIAdapterConfig {
  apiKey: string;
  /** 适配器名称（用于注册和选择，默认 'openai'） */
  name?: string;
  baseURL?: string;
  organization?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** 单次 API 请求超时（毫秒），默认 120000（2 分钟） */
  timeout?: number;
  [key: string]: any;
}

/**
 * OpenAI 提供者适配器，实现 ProviderAdapter 接口。
 * 支持 OpenAI Chat Completions API 和 OpenAI 兼容 API（如 NVIDIA）。
 */
export class OpenAIAdapter implements ProviderAdapter {
  public readonly name: string;
  private client: OpenAI;
  private model: string;
  private defaultParams: Omit<OpenAIAdapterConfig, 'apiKey' | 'baseURL' | 'organization' | 'model'>;

  constructor(config: OpenAIAdapterConfig) {
    this.name = config.name ?? 'openai';
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      organization: config.organization,
      timeout: config.timeout ?? 120_000,       // 2 分钟超时，防止无限挂起
      maxRetries: 0,                            // 重试由上层 LLMAdapter.withRetry 统一处理
    });
    this.model = config.model;
    const { apiKey, baseURL, organization, model, timeout, ...rest } = config;
    this.defaultParams = rest;
  }

  /**
   * 向 OpenAI Chat Completions API 发送聊天请求。
   * 将 UnifiedMessage[] 转换为 OpenAI 格式，发送请求，再将响应转换回来。
   */
  async chat(messages: UnifiedMessage[], options: LLMOptions): Promise<LLMResponse> {
    try {
      const openaiMessages = this.convertToOpenAIMessages(messages);
      const params = this.buildRequestParams(openaiMessages, options, false);

      console.log(`[OpenAI] chat 请求 → model=${params.model}, messages=${openaiMessages.length}条, tools=${params.tools?.length ?? 0}个`);
      const startTime = Date.now();

      const response = await this.client.chat.completions.create(params);

      const elapsed = Date.now() - startTime;
      const usage = (response as OpenAI.ChatCompletion).usage;
      console.log(`[OpenAI] chat 响应 ← ${elapsed}ms | tokens: ${usage?.prompt_tokens ?? '?'}→${usage?.completion_tokens ?? '?'}`);

      return this.convertResponse(response as OpenAI.ChatCompletion);
    } catch (error) {
      throw this.convertError(error);
    }
  }

  /**
   * 向 OpenAI Chat Completions API 发送流式聊天请求。
   * 处理 delta.content 和 delta.reasoning_content 字段。
   */
  async stream(
    messages: UnifiedMessage[],
    callback: StreamCallback,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    try {
      const openaiMessages = this.convertToOpenAIMessages(messages);
      const params = this.buildRequestParams(openaiMessages, options, true);

      console.log(`[OpenAI] stream 请求 → model=${params.model}, messages=${openaiMessages.length}条, tools=${params.tools?.length ?? 0}个`);
      const startTime = Date.now();

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

      const elapsed = Date.now() - startTime;
      console.log(`[OpenAI] stream 完成 ← ${elapsed}ms | tokens: ${promptTokens}→${completionTokens}`);

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
   * 简单的 token 估算：大约每 4 个字符一个 token。
   */
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  /**
   * 将 UnifiedMessage[] 转换为 OpenAI ChatCompletionMessageParam[]。
   *
   * 包含兜底校验：确保每个 assistant(tool_calls) 的 tool_call_id
   * 都有对应的 tool 消息，防止 OpenAI API 返回 400 错误。
   */
  private convertToOpenAIMessages(
    messages: UnifiedMessage[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const converted = messages.map((msg) => this.convertSingleMessage(msg));
    return this.validateToolCallPairing(converted);
  }

  /**
   * 最终兜底：校验 OpenAI 消息格式中 tool_calls 与 tool 消息的配对完整性。
   *
   * OpenAI API 严格要求：assistant 消息中的每个 tool_call id 必须有
   * 一条 role=tool + tool_call_id 的消息与之对应，否则返回 400。
   *
   * 此方法作为发送前的最后一道防线，在 normalizeMessages 之后再做一次检查。
   */
  private validateToolCallPairing(
    messages: OpenAI.ChatCompletionMessageParam[],
  ): OpenAI.ChatCompletionMessageParam[] {
    // 收集所有 assistant 的 tool_call id
    const requiredIds = new Map<string, number>(); // id -> assistant 消息索引
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          requiredIds.set(tc.id, i);
        }
      }
    }

    if (requiredIds.size === 0) return messages;

    // 收集已有的 tool 消息 id
    const existingToolIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'tool' && 'tool_call_id' in msg && msg.tool_call_id) {
        existingToolIds.add(msg.tool_call_id);
      }
    }

    // 找缺失的
    const missingIds: { id: string; assistantIdx: number }[] = [];
    for (const [id, idx] of requiredIds) {
      if (!existingToolIds.has(id)) {
        missingIds.push({ id, assistantIdx: idx });
      }
    }

    if (missingIds.length === 0) return messages;

    // 按 assistantIdx 分组
    const missingByIdx = new Map<number, string[]>();
    for (const { id, assistantIdx } of missingIds) {
      if (!missingByIdx.has(assistantIdx)) {
        missingByIdx.set(assistantIdx, []);
      }
      missingByIdx.get(assistantIdx)!.push(id);
    }

    // 插入占位 tool 消息
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    for (let i = 0; i < messages.length; i++) {
      result.push(messages[i]);

      if (missingByIdx.has(i)) {
        // 跳过紧随其后的已有 tool 消息（它们已经在 result 中了，下一轮循环会加）
        // 找到该 assistant 后面连续 tool 消息的末尾
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          result.push(messages[j]);
          j++;
        }
        // 在末尾补齐缺失的
        for (const missingId of missingByIdx.get(i)!) {
          result.push({
            role: 'tool',
            content: '[工具结果丢失]',
            tool_call_id: missingId,
          });
        }
        // 跳过已处理的
        i = j - 1;
      }
    }

    return result;
  }

  /**
   * 将单个 UnifiedMessage 转换为 OpenAI 消息格式。
   */
  private convertSingleMessage(msg: UnifiedMessage): OpenAI.ChatCompletionMessageParam {
    const content = this.resolveContent(msg.content);

    switch (msg.role) {
      case 'system':
        return { role: 'system', content };
      case 'user':
        return { role: 'user', content };
      case 'assistant': {
        const assistantMsg: any = {
          role: 'assistant',
          content,
        };
        // 传回 reasoning_content（DeepSeek thinking 模式要求）
        if (msg.reasoningContent) {
          assistantMsg.reasoning_content = msg.reasoningContent;
        }
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
   * 将内容从 string 或 ContentBlock[] 解析为 string。
   * 清理可能导致 JSON 解析失败的非法字符。
   */
  private resolveContent(content: string | ContentBlock[]): string {
    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else {
      text = content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text!)
        .join('\n');
    }
    // 清理非法的转义序列（如 \x 开头的十六进制转义），防止 API JSON 解析失败
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  /**
   * 构建 OpenAI API 调用的请求参数。
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

    // 应用默认参数
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

    // 使用每次调用的选项覆盖
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

    // 处理工具（Function Calling）
    if (options.tools && options.tools.length > 0) {
      params.tools = this.convertToolDefinitions(options.tools);
    }

    // 透传提供者特定参数（如 NVIDIA 的 chat_template_kwargs）
    if (options.chatTemplateKwargs) {
      params.chat_template_kwargs = options.chatTemplateKwargs;
    }

    // 在流式模式中包含 stream_options 以获取使用统计
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

    const content = message?.content || '';

    // 提取 reasoning_content（DeepSeek 等 thinking 模型）
    const messageAny = message as any;
    const reasoningContent = messageAny?.reasoning_content || undefined;

    const toolCalls = this.parseToolCalls(message?.tool_calls);

    return {
      content,
      reasoningContent,
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
   * 将 OpenAI API 错误转换为统一错误格式。
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
