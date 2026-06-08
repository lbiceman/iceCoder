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
import { extractPromptCacheFromChatUsage } from './chat-completion-usage.js';
import { estimateStringTokens } from './token-estimator.js';
import { prepareToolsForChatCompletions } from './tool-offering.js';
import { normalizeToolArguments } from '../tools/tool-arguments-normalizer.js';
import { isAbortError, makeAbortedError } from './abort-error.js';

/** 顶层请求参数字段顺序 — 保证同配置多轮 JSON 字节一致 */
const FIXED_CHAT_PARAM_KEYS = [
  'model',
  'messages',
  'stream',
  'tools',
  'temperature',
  'max_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stream_options',
  'chat_template_kwargs',
  'extra_body',
] as const;

/** 移除 undefined/null 并按固定 key 顺序整理请求体 */
export function orderRequestParams(params: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const key of FIXED_CHAT_PARAM_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      ordered[key] = value;
      seen.add(key);
    }
  }

  const extraKeys = Object.keys(params)
    .filter((k) => !seen.has(k))
    .sort((a, b) => a.localeCompare(b));
  for (const key of extraKeys) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      ordered[key] = value;
    }
  }

  return ordered;
}

/** 合并全部 system 为一条并置于首位（供 MiniMax 等严格 OpenAI 兼容端点使用）。 */
export function collapseUnifiedSystemMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  const systemParts: string[] = [];
  const rest: UnifiedMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n');
      if (text) systemParts.push(text);
    } else {
      rest.push(msg);
    }
  }
  if (systemParts.length === 0) return messages;
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}

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
  /** 是否支持视觉/图片输入（默认自动检测：gpt-4o/gpt-4-vision 等支持，其他不支持） */
  supportsVision?: boolean;
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
  private supportsVision: boolean;
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
    // 视觉支持：显式配置 > 自动检测
    this.supportsVision = config.supportsVision ?? this.detectVisionSupport(config.model);
    const { apiKey, baseURL, organization, model, timeout, supportsVision, ...rest } = config;
    this.defaultParams = rest;
  }

  /**
   * 根据模型名称自动检测是否支持视觉输入。
   * 已知支持视觉的模型模式：gpt-4o, gpt-4-vision, gpt-4-turbo (2024+), qwen-vl 等。
   * 保守策略：未知模型默认不支持。
   */
  private detectVisionSupport(model: string): boolean {
    const m = model.toLowerCase();
    // OpenAI 视觉模型
    if (m.includes('gpt-4o') || m.includes('gpt-4-vision') || m.includes('gpt-4-turbo')) return true;
    // 通义千问视觉
    if (m.includes('qwen-vl') || m.includes('qwen2-vl')) return true;
    // Google Gemini
    if (m.includes('gemini')) return true;
    // Xiaomi MiMo Omni 等多模态
    if (m.includes('omni') || m.includes('-vl') || m.includes('_vl')) return true;
    // 默认不支持（DeepSeek、GLM 等纯文本模型）
    return false;
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

      const signal = options.signal ?? undefined;
      if (signal?.aborted) throw makeAbortedError(this.name);
      const response = await this.client.chat.completions.create(params, signal ? { signal } : undefined);

      const elapsed = Date.now() - startTime;
      const usage = (response as OpenAI.ChatCompletion).usage;
      const pc = usage ? extractPromptCacheFromChatUsage(usage) : {};
      const cacheFrag =
        pc.cacheReadTokens != null || pc.cacheMissTokens != null
          ? ` | cache_hit/miss=${pc.cacheReadTokens ?? '?'}/${pc.cacheMissTokens ?? '?'}`
          : '';
      console.log(
        `[OpenAI] chat 响应: ${elapsed}ms | tokens: ${usage?.prompt_tokens ?? '?'} | ${usage?.completion_tokens ?? '?'}${cacheFrag}`,
      );

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

      const signal = options.signal ?? undefined;
      if (signal?.aborted) throw makeAbortedError(this.name);
      const stream = await this.client.chat.completions.create(
        { ...params, stream: true },
        signal ? { signal } : undefined,
      );

      let fullContent = '';
      let reasoningContent = '';
      let finishReason: LLMResponse['finishReason'] = 'stop';
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let promptTokens = 0;
      let completionTokens = 0;
      let lastUsageExtras: ReturnType<typeof extractPromptCacheFromChatUsage> = {};

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const chunkFinishReason = chunk.choices?.[0]?.finish_reason;

        if (delta) {
          // Handle regular content
          if (delta.content) {
            fullContent += delta.content;
            callback(delta.content, false);
          }

          // reasoning_content / reasoning_details：经独立 channel 推前端；不回传 API
          const deltaAny = delta as any;
          const reasoningDelta = this.extractStreamReasoningDelta(deltaAny);
          if (reasoningDelta) {
            reasoningContent += reasoningDelta;
            callback({ channel: 'reasoning', delta: reasoningDelta }, false);
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
          lastUsageExtras = extractPromptCacheFromChatUsage(chunk.usage);
        }
      }

      callback('', true);

      const elapsed = Date.now() - startTime;
      const streamCacheFrag =
        lastUsageExtras.cacheReadTokens != null || lastUsageExtras.cacheMissTokens != null
          ? ` | cache_hit|miss=${lastUsageExtras.cacheReadTokens ?? '?'}|${lastUsageExtras.cacheMissTokens ?? '?'}`
          : '';
      console.log(
        `[OpenAI] stream 完成 : ${elapsed}ms | tokens: ${promptTokens} | ${completionTokens}${streamCacheFrag}`,
      );

      const parsedToolCalls = this.parseStreamToolCalls(toolCalls);

      return {
        content: fullContent,
        reasoningContent: reasoningContent || undefined,
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: promptTokens + completionTokens,
          provider: this.name,
          ...lastUsageExtras,
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
    return estimateStringTokens(text);
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
    const stripped = messages.map((m) => {
      if (m.role === 'assistant' && m.reasoningContent !== undefined) {
        const { reasoningContent: _r, ...rest } = m;
        return rest;
      }
      return m;
    });

    const withCollapsedSystem = collapseUnifiedSystemMessages(stripped);
    const converted = withCollapsedSystem.map((msg) => this.convertSingleMessage(msg));
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
    const requiredIdSet = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          requiredIdSet.add(tc.id);
        }
      }
    }

    if (requiredIdSet.size === 0) {
      return messages.filter(m => m.role !== 'tool');
    }

    // 移除无对应 assistant tool_call 的孤立 tool 消息
    const withoutOrphans = messages.filter(m => {
      if (m.role !== 'tool' || !('tool_call_id' in m) || !m.tool_call_id) return true;
      return requiredIdSet.has(m.tool_call_id);
    });

    const requiredIds = new Map<string, number>();
    for (let i = 0; i < withoutOrphans.length; i++) {
      const msg = withoutOrphans[i]!;
      if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          requiredIds.set(tc.id, i);
        }
      }
    }

    // 收集已有的 tool 消息 id
    const existingToolIds = new Set<string>();
    for (const msg of withoutOrphans) {
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

    if (missingIds.length === 0) return withoutOrphans;

    // 按 assistantIdx 分组
    const missingByIdx = new Map<number, string[]>();
    for (const { id, assistantIdx } of missingIds) {
      if (!missingByIdx.has(assistantIdx)) {
        missingByIdx.set(assistantIdx, []);
      }
      missingByIdx.get(assistantIdx)!.push(id);
    }

    // 插入占位 tool 消息（不重复推送紧随 assistant 的已有 tool）
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    for (let i = 0; i < withoutOrphans.length; i++) {
      const msg = withoutOrphans[i]!;
      result.push(msg);

      if (msg.role !== 'assistant' || !missingByIdx.has(i)) continue;

      let j = i + 1;
      while (j < withoutOrphans.length && withoutOrphans[j]?.role === 'tool') {
        result.push(withoutOrphans[j]!);
        j++;
      }
      for (const missingId of missingByIdx.get(i)!) {
        result.push({
          role: 'tool',
          content: '[工具结果丢失]',
          tool_call_id: missingId,
        });
      }
      i = j - 1;
    }

    return result;
  }

  /**
   * 将单个 UnifiedMessage 转换为 OpenAI 消息格式。
   */
  private convertSingleMessage(msg: UnifiedMessage): OpenAI.ChatCompletionMessageParam {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: this.resolveContent(msg.content) };
      case 'user': {
        // 检查是否包含图片内容块
        if (Array.isArray(msg.content)) {
          const hasImage = msg.content.some(b => b.type === 'image' && b.imageUrl);
          if (hasImage) {
            if (this.supportsVision) {
              // 视觉模型：发送图片内容
              const parts: OpenAI.ChatCompletionContentPart[] = [];
              for (const block of msg.content) {
                if (block.type === 'text' && block.text) {
                  parts.push({ type: 'text', text: this.cleanText(block.text) });
                } else if (block.type === 'image' && block.imageUrl) {
                  parts.push({
                    type: 'image_url',
                    image_url: { url: block.imageUrl },
                  });
                }
              }
              return { role: 'user', content: parts };
            } else {
              // 非视觉模型：降级为纯文本，提示用户
              const textParts: string[] = [];
              let imageCount = 0;
              for (const block of msg.content) {
                if (block.type === 'text' && block.text) {
                  textParts.push(this.cleanText(block.text));
                } else if (block.type === 'image') {
                  imageCount++;
                }
              }
              if (imageCount > 0) {
                const combined = textParts.join('\n');
                const hasPersistedImageHint = /image_read|imagesCache/i.test(combined);
                if (!hasPersistedImageHint) {
                  textParts.push(`[用户发送了 ${imageCount} 张图片，但当前模型 ${this.model} 不支持图片理解。请提示用户切换到支持视觉的模型（如 gpt-4o）或用文字描述图片内容。]`);
                }
              }
              return { role: 'user', content: textParts.join('\n') };
            }
          }
        }
        return { role: 'user', content: this.resolveContent(msg.content) };
      }
      case 'assistant': {
        const assistantMsg: any = {
          role: 'assistant',
          content: this.resolveContent(msg.content),
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
          content: this.resolveContent(msg.content),
          tool_call_id: msg.toolCallId || '',
        };
      default:
        return { role: 'user', content: this.resolveContent(msg.content) };
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
    return this.cleanText(text);
  }

  /**
   * 清理文本中可能导致 API JSON 解析失败的非法字符。
   */
  private cleanText(text: string): string {
    // 1. 清理 ASCII 控制字符（保留 \t \n \r）
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // 2. 清理 lone surrogates（U+D800-U+DFFF），这些在 JSON 中非法
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
    // 3. 清理其他 Unicode 控制字符（C1 控制字符 U+0080-U+009F）
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\x80-\x9F]/g, '');
    return text;
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

    // 处理工具（Function Calling）；排序 + 可选瘦描述 → 前缀更稳、更小
    const prepared = prepareToolsForChatCompletions(options.tools);
    if (prepared && prepared.length > 0) {
      params.tools = this.convertToolDefinitions(prepared);
    }

    // 透传提供者特定参数（如 NVIDIA 的 chat_template_kwargs）
    if (options.chatTemplateKwargs) {
      params.chat_template_kwargs = options.chatTemplateKwargs;
    }

    // 在流式模式中包含 stream_options 以获取使用统计
    if (stream) {
      params.stream_options = { include_usage: true };
    }

    // MiniMax：拆分思考链到 reasoning 字段，供 Web 思考块展示
    if (this.shouldUseReasoningSplit(model)) {
      params.extra_body = {
        ...(params.extra_body ?? {}),
        reasoning_split: true,
      };
    }

    return orderRequestParams(params) as unknown as OpenAI.ChatCompletionCreateParams;
  }

  /** MiniMax M2/M3 等：启用 reasoning_split 将思考从 content 分离。 */
  private shouldUseReasoningSplit(model: string): boolean {
    return model.toLowerCase().includes('minimax');
  }

  /** 流式 delta 中的思考增量（DeepSeek reasoning_content / MiniMax reasoning_details）。 */
  private extractStreamReasoningDelta(deltaAny: Record<string, unknown>): string {
    if (typeof deltaAny.reasoning_content === 'string' && deltaAny.reasoning_content) {
      return deltaAny.reasoning_content;
    }
    const details = deltaAny.reasoning_details;
    if (!Array.isArray(details)) return '';
    let parts = '';
    for (const detail of details) {
      if (detail && typeof detail === 'object' && typeof (detail as { text?: string }).text === 'string') {
        parts += (detail as { text: string }).text;
      }
    }
    return parts;
  }

  /** 非流式 message 中的思考全文。 */
  private extractMessageReasoningContent(messageAny: Record<string, unknown>): string | undefined {
    if (typeof messageAny.reasoning_content === 'string' && messageAny.reasoning_content) {
      return messageAny.reasoning_content;
    }
    const details = messageAny.reasoning_details;
    if (!Array.isArray(details)) return undefined;
    const parts = details
      .map((detail) => (
        detail && typeof detail === 'object' && typeof (detail as { text?: string }).text === 'string'
          ? (detail as { text: string }).text
          : ''
      ))
      .filter(Boolean);
    return parts.length > 0 ? parts.join('') : undefined;
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

    const messageAny = message as unknown as Record<string, unknown>;
    const reasoningContent = this.extractMessageReasoningContent(messageAny);

    const toolCalls = this.parseToolCalls(message?.tool_calls);

    const cacheSlice = extractPromptCacheFromChatUsage(response.usage ?? null);

    return {
      content,
      reasoningContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens:
          response.usage?.total_tokens
          ?? (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0),
        provider: this.name,
        ...cacheSlice,
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
      return normalizeToolArguments(JSON.parse(jsonStr)) as Record<string, any>;
    } catch {
      return normalizeToolArguments({ raw: jsonStr }) as Record<string, any>;
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
    if (isAbortError(error)) {
      const aborted = makeAbortedError(this.name);
      (aborted as any).provider = this.name;
      return aborted;
    }
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
