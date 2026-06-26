/**
 * OpenAI Responses API 桥接（Bedrock Mantle GPT-5.4/5.5 等仅支持此 API）。
 */

import OpenAI from 'openai';
import type {
  LLMOptions,
  LLMResponse,
  StreamCallback,
  ToolCall,
  ToolDefinition,
  UnifiedMessage,
} from './types.js';
import { collapseUnifiedSystemMessages } from './openai-message-utils.js';
import { prepareToolsForChatCompletions } from './tool-offering.js';
import {
  cleanText,
  resolveContentText as resolveText,
  safeParseToolArguments as safeParseJSON,
} from './text-sanitize.js';

export type OpenAiApiMode = 'chat_completions' | 'responses';

export function resolveOpenAiApiMode(model: string, apiMode?: string): OpenAiApiMode {
  if (apiMode === 'responses' || apiMode === 'chat_completions') return apiMode;
  // Bedrock Mantle 上 OpenAI GPT-5.4/5.5 仅支持 Responses API
  if (/^openai\.gpt-5\.(4|5)$/i.test(model)) return 'responses';
  return 'chat_completions';
}

function convertToResponsesInput(
  messages: UnifiedMessage[],
  supportsVision: boolean,
  model: string,
): OpenAI.Responses.ResponseInput {
  const stripped = messages.map((m) => {
    if (m.role === 'assistant' && m.reasoningContent !== undefined) {
      const { reasoningContent: _r, ...rest } = m;
      return rest;
    }
    return m;
  });
  const collapsed = collapseUnifiedSystemMessages(stripped);
  const items: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of collapsed) {
    switch (msg.role) {
      case 'system':
        items.push({ role: 'system', content: resolveText(msg.content) });
        break;
      case 'user': {
        if (Array.isArray(msg.content)) {
          const hasImage = msg.content.some((b) => b.type === 'image' && b.imageUrl);
          if (hasImage && supportsVision) {
            const parts: OpenAI.Responses.ResponseInputContent[] = [];
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                parts.push({ type: 'input_text', text: cleanText(block.text) });
              } else if (block.type === 'image' && block.imageUrl) {
                parts.push({
                  type: 'input_image',
                  image_url: block.imageUrl,
                  detail: 'auto',
                });
              }
            }
            items.push({ role: 'user', content: parts });
          } else {
            let textParts: string[] = [];
            let imageCount = 0;
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) textParts.push(cleanText(block.text));
              else if (block.type === 'image') imageCount++;
            }
            if (imageCount > 0 && !supportsVision) {
              textParts.push(
                `[用户发送了 ${imageCount} 张图片，但当前模型 ${model} 不支持图片理解。]`,
              );
            }
            items.push({ role: 'user', content: textParts.join('\n') });
          }
        } else {
          items.push({ role: 'user', content: resolveText(msg.content) });
        }
        break;
      }
      case 'assistant': {
        const text = resolveText(msg.content);
        if (text) {
          items.push({ role: 'assistant', content: text });
        }
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            items.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            });
          }
        }
        break;
      }
      case 'tool':
        if (msg.toolCallId) {
          items.push({
            type: 'function_call_output',
            call_id: msg.toolCallId,
            output: resolveText(msg.content),
          });
        }
        break;
      default:
        items.push({ role: 'user', content: resolveText(msg.content) });
        break;
    }
  }

  return items;
}

function convertResponsesTools(tools: ToolDefinition[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function buildResponsesParams(
  messages: UnifiedMessage[],
  options: LLMOptions,
  model: string,
  defaultParams: Record<string, unknown>,
  supportsVision: boolean,
  stream: boolean,
): OpenAI.Responses.ResponseCreateParams {
  const resolvedModel = options.model || model;
  const params: Record<string, unknown> = {
    model: resolvedModel,
    input: convertToResponsesInput(messages, supportsVision, resolvedModel),
    stream,
  };

  if (defaultParams.temperature !== undefined) params.temperature = defaultParams.temperature;
  if (defaultParams.maxTokens !== undefined) params.max_output_tokens = defaultParams.maxTokens;
  if (defaultParams.topP !== undefined) params.top_p = defaultParams.topP;

  if (options.temperature !== undefined) params.temperature = options.temperature;
  if (options.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;
  if (options.topP !== undefined) params.top_p = options.topP;

  const prepared = prepareToolsForChatCompletions(options.tools);
  if (prepared?.length) {
    params.tools = convertResponsesTools(prepared);
  }

  return params as OpenAI.Responses.ResponseCreateParams;
}

function extractReasoningFromOutput(
  output: OpenAI.Responses.ResponseOutputItem[],
): string | undefined {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== 'reasoning') continue;
    const reasoning = item as OpenAI.Responses.ResponseReasoningItem;
    if (reasoning.content) {
      for (const c of reasoning.content) {
        if (c.text) parts.push(c.text);
      }
    }
    for (const s of reasoning.summary) {
      if (s.text) parts.push(s.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function parseToolCallsFromOutput(output: OpenAI.Responses.ResponseOutputItem[]): ToolCall[] {
  const result: ToolCall[] = [];
  for (const item of output) {
    if (item.type !== 'function_call') continue;
    const fc = item as OpenAI.Responses.ResponseFunctionToolCall;
    result.push({
      id: fc.call_id,
      name: fc.name,
      arguments: safeParseJSON(fc.arguments),
    });
  }
  return result;
}

function mapResponsesFinishReason(
  status: string | undefined,
  toolCalls: ToolCall[],
): LLMResponse['finishReason'] {
  if (toolCalls.length > 0) return 'tool_calls';
  if (status === 'incomplete') return 'length';
  return 'stop';
}

function convertResponsesResponse(
  response: OpenAI.Responses.Response,
  providerName: string,
): LLMResponse {
  const toolCalls = parseToolCallsFromOutput(response.output);
  const reasoningContent = extractReasoningFromOutput(response.output);
  const usage = response.usage;

  return {
    content: response.output_text || '',
    reasoningContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      provider: providerName,
      cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? undefined,
    },
    finishReason: mapResponsesFinishReason(response.status, toolCalls),
  };
}

export async function responsesChat(
  client: OpenAI,
  messages: UnifiedMessage[],
  options: LLMOptions,
  ctx: {
    providerName: string;
    model: string;
    defaultParams: Record<string, unknown>;
    supportsVision: boolean;
    reqOpts: { signal?: AbortSignal; timeout: number };
  },
): Promise<LLMResponse> {
  const params = buildResponsesParams(
    messages,
    options,
    ctx.model,
    ctx.defaultParams,
    ctx.supportsVision,
    false,
  );
  const response = await client.responses.create(
    params as OpenAI.Responses.ResponseCreateParamsNonStreaming,
    ctx.reqOpts,
  );
  return convertResponsesResponse(response, ctx.providerName);
}

export async function responsesStream(
  client: OpenAI,
  messages: UnifiedMessage[],
  callback: StreamCallback,
  options: LLMOptions,
  ctx: {
    providerName: string;
    model: string;
    defaultParams: Record<string, unknown>;
    supportsVision: boolean;
    reqOpts: { signal?: AbortSignal; timeout: number };
  },
): Promise<LLMResponse> {
  const params = buildResponsesParams(
    messages,
    options,
    ctx.model,
    ctx.defaultParams,
    ctx.supportsVision,
    true,
  );
  const stream = await client.responses.create(
    { ...params, stream: true } as OpenAI.Responses.ResponseCreateParamsStreaming,
    ctx.reqOpts,
  );

  let fullContent = '';
  let reasoningContent = '';
  let finishReason: LLMResponse['finishReason'] = 'stop';
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens: number | undefined;
  const pendingCalls = new Map<string, { call_id: string; name: string; arguments: string }>();

  for await (const event of stream) {
    const type = event.type;

    if (type === 'response.output_text.delta') {
      const delta = (event as OpenAI.Responses.ResponseTextDeltaEvent).delta;
      if (delta) {
        fullContent += delta;
        callback(delta, false);
      }
    } else if (type === 'response.reasoning_text.delta') {
      const delta = (event as OpenAI.Responses.ResponseReasoningTextDeltaEvent).delta;
      if (delta) {
        reasoningContent += delta;
        callback({ channel: 'reasoning', delta }, false);
      }
    } else if (type === 'response.output_item.added') {
      const item = (event as OpenAI.Responses.ResponseOutputItemAddedEvent).item;
      if (item.type === 'function_call' && item.id) {
        const fc = item as OpenAI.Responses.ResponseFunctionToolCall;
        pendingCalls.set(item.id, {
          call_id: fc.call_id,
          name: fc.name,
          arguments: fc.arguments || '',
        });
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const ev = event as OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent;
      const call = pendingCalls.get(ev.item_id);
      if (call) call.arguments += ev.delta;
    } else if (type === 'response.function_call_arguments.done') {
      const ev = event as OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent;
      const call = pendingCalls.get(ev.item_id);
      if (call) {
        call.name = ev.name;
        call.arguments = ev.arguments;
      }
    } else if (type === 'response.output_item.done') {
      const item = (event as OpenAI.Responses.ResponseOutputItemDoneEvent).item;
      if (item.type === 'function_call' && item.id) {
        const fc = item as OpenAI.Responses.ResponseFunctionToolCall;
        pendingCalls.set(item.id, {
          call_id: fc.call_id,
          name: fc.name,
          arguments: fc.arguments || '',
        });
      }
    } else if (type === 'response.completed') {
      const response = (event as OpenAI.Responses.ResponseCompletedEvent).response;
      const usage = response.usage;
      if (usage) {
        promptTokens = usage.input_tokens ?? 0;
        completionTokens = usage.output_tokens ?? 0;
        cacheReadTokens = usage.input_tokens_details?.cached_tokens;
      }
      const toolCalls = parseToolCallsFromOutput(response.output);
      finishReason = mapResponsesFinishReason(response.status, toolCalls);
      if (!fullContent && response.output_text) {
        fullContent = response.output_text;
      }
      if (!reasoningContent) {
        const r = extractReasoningFromOutput(response.output);
        if (r) reasoningContent = r;
      }
      for (const tc of toolCalls) {
        const existing = [...pendingCalls.values()].find((c) => c.call_id === tc.id);
        if (!existing) {
          pendingCalls.set(`done-${tc.id}`, {
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
      }
    }
  }

  callback('', true);

  const parsedToolCalls: ToolCall[] = [];
  for (const call of pendingCalls.values()) {
    parsedToolCalls.push({
      id: call.call_id,
      name: call.name,
      arguments: safeParseJSON(call.arguments),
    });
  }

  return {
    content: fullContent,
    reasoningContent: reasoningContent || undefined,
    toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
    usage: {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      totalTokens: promptTokens + completionTokens,
      provider: ctx.providerName,
      cacheReadTokens,
    },
    finishReason: parsedToolCalls.length > 0 ? 'tool_calls' : finishReason,
  };
}
