/**
 * 记忆召回测试 API（挂载在 /api/memory）。
 *
 * POST /recall — 给定 query，走完整语义召回管线返回记忆文件内容。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { recallRelevantMemories } from '../../memory/file-memory/memory-recall.js';
import { MEMORY_MAX_RELEVANT } from '../../memory/file-memory/memory-config.js';
import type { LLMAdapter } from '../../llm/llm-adapter.js';

const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR || './data/memory-files';

/** 创建挂载于 /api/memory 的路由（当前仅 recall 测试）。 */
export function createMemoryExportRouter(llmAdapter?: LLMAdapter): Router {
  const router = Router();

  /**
   * POST /recall — 召回测试：给定 query，返回召回的记忆文件内容。
   * 走完整的 LLM 语义召回管线，但不让模型回答问题。
   * Body: { "query": "...", "topK": 10 }
   */
  router.post('/recall', async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, topK } = req.body as { query: string; topK?: number };
      if (!query) {
        res.status(400).json({ success: false, error: 'Missing query' });
        return;
      }

      const memoryDir = path.resolve(DEFAULT_MEMORY_DIR);
      const k = topK ?? MEMORY_MAX_RELEVANT;

      const adapter = llmAdapter
        ? {
            chat: async (msgs: Parameters<LLMAdapter['chat']>[0], opts?: Parameters<LLMAdapter['chat']>[1]) =>
              llmAdapter.chat(msgs, { tools: [], ...opts }),
            stream: async () => {
              throw new Error('Not supported');
            },
            countTokens: async (text: string) => Math.ceil(text.length / 4),
          }
        : null;

      const result = await recallRelevantMemories(query, memoryDir, adapter, new Set(), k);

      const recalled = [];
      for (const mem of result.memories) {
        let content = '';
        try {
          content = await fs.readFile(mem.filePath, 'utf-8');
        } catch {
          /* skip */
        }
        recalled.push({
          filename: mem.filename,
          description: mem.description,
          tags: mem.tags,
          content,
        });
      }

      res.json({
        success: true,
        query,
        topK: k,
        usedLLM: result.usedLLM,
        duration: result.duration,
        recalled: recalled.length,
        files: recalled,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
