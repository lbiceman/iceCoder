/**
 * 工具系统的类型定义。
 * 定义工具接口、工具执行结果、工具注册表接口。
 */

import type { ToolDefinition } from '../llm/types.js';

/**
 * 工具执行结果。
 */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * 工具处理器函数类型。
 */
export type ToolHandler = (args: Record<string, any>) => Promise<ToolResult>;

/**
 * 已注册的工具，包含定义和处理器。
 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * 工具注册表接口。
 */
export interface ToolRegistry {
  register(tool: RegisteredTool): void;
  get(name: string): RegisteredTool | undefined;
  getAll(): RegisteredTool[];
  getDefinitions(): ToolDefinition[];
  has(name: string): boolean;
}

/**
 * 工具执行器配置。
 * 注意：循环控制（maxRounds 等）由 Harness 层负责，不在这里。
 */
export interface ToolExecutorConfig {
  /** 单个工具调用的最大重试次数 */
  maxRetries: number;
  /** 重试基础延迟（毫秒） */
  retryBaseDelay: number;
  /** 重试最大延迟（毫秒） */
  retryMaxDelay: number;
  /** 单个工具调用超时（毫秒） */
  toolTimeout: number;
}
