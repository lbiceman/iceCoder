/**
 * 轻量编排器：聚合 FileParser 与 LLMAdapter，供 WebSocket 聊天等入口获取共享实例。
 * 原多智能体流水线与阶段编排已移除。
 */

import type { LLMAdapter } from './types.js';
import type { FileParser } from '../parser/file-parser.js';

export interface OrchestratorConfig {
  /** 产物输出目录（预留） */
  outputDir?: string;
  /** 会话目录（预留，例如结构化 checkpoint 路径） */
  sessionDir?: string;
}

export class Orchestrator {
  private readonly fileParser: FileParser;
  private readonly llmAdapter: LLMAdapter;
  private readonly config: OrchestratorConfig;

  constructor(fileParser: FileParser, llmAdapter: LLMAdapter, config: OrchestratorConfig = {}) {
    this.fileParser = fileParser;
    this.llmAdapter = llmAdapter;
    this.config = config;
  }

  getLLMAdapter(): LLMAdapter {
    return this.llmAdapter;
  }

  getFileParser(): FileParser {
    return this.fileParser;
  }

  /** @internal 预留：会话与输出路径 */
  getConfig(): Readonly<OrchestratorConfig> {
    return this.config;
  }
}
