/**
 * 轻量编排器：聚合 FileParser 与 LLMAdapter，供 WebSocket 聊天等入口获取共享实例。
 * 职责仅为持有共享依赖；原多智能体流水线已移除。
 */

import type { LLMAdapter } from './types.js';
import type { FileParser } from '../parser/file-parser.js';

export class Orchestrator {
  private readonly fileParser: FileParser;
  private readonly llmAdapter: LLMAdapter;

  constructor(fileParser: FileParser, llmAdapter: LLMAdapter) {
    this.fileParser = fileParser;
    this.llmAdapter = llmAdapter;
  }

  getLLMAdapter(): LLMAdapter {
    return this.llmAdapter;
  }

  getFileParser(): FileParser {
    return this.fileParser;
  }
}
