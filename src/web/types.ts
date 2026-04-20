/**
 * Web 服务器模块的类型定义。
 * 定义提供者配置和 SSE 事件类型。
 */

import type { StageStatus, PipelineState } from '../core/types.js';

/**
 * LLM 提供者配置，存储在 data/config.json 中。
 */
export interface ProviderConfig {
  id: string;
  providerName: string;
  apiUrl: string;
  apiKey: string;
  modelName: string;
  parameters: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    chatTemplateKwargs?: Record<string, any>;
    [key: string]: any;
  };
  isDefault?: boolean;
}

/**
 * 服务器推送事件（SSE）结构，用于与客户端的实时通信。
 */
export interface SSEEvent {
  type: 'message' | 'stage_update' | 'pipeline_complete' | 'error';
  data: {
    content?: string;
    stageStatus?: StageStatus;
    pipelineState?: PipelineState;
    error?: string;
  };
}
