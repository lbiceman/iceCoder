/**
 * 记忆 API（挂载在 /api/memory）。
 *
 * POST /recall  — 召回测试
 * GET  /export  — 将记忆文件打包为 ZIP 下载（memory-files/ + user-memory/ 目录结构）
 * GET  /stats   — 导出前预览：文件数统计
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { recallRelevantMemories } from '../../memory/file-memory/memory-recall.js';
import { MEMORY_MAX_RELEVANT } from '../../memory/file-memory/memory-config.js';
import type { LLMAdapter } from '../../llm/llm-adapter.js';
import '../../cli/paths.js';

const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR!;
const DEFAULT_USER_MEMORY_DIR = process.env.ICE_USER_MEMORY_DIR!;

/** 递归扫描目录中的所有 .md 文件（相对路径，正斜杠）。 */
async function scanMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { recursive: true });
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.endsWith('.md')) {
        results.push(entry.replace(/\\/g, '/'));
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return results;
}

/** 将项目级与用户级记忆打包为 ZIP buffer。 */
async function packMemoriesZip(
  projectDir: string,
  userDir: string,
): Promise<{ buffer: Buffer; fileCount: number }> {
  const zip = new JSZip();
  const projectFiles = await scanMdFiles(projectDir);
  const userFiles = await scanMdFiles(userDir);
  const projectFolder = path.basename(projectDir);
  const userFolder = path.basename(userDir);

  for (const rel of projectFiles) {
    const content = await fs.readFile(path.join(projectDir, rel));
    zip.file(`${projectFolder}/${rel}`, content);
  }
  for (const rel of userFiles) {
    const content = await fs.readFile(path.join(userDir, rel));
    zip.file(`${userFolder}/${rel}`, content);
  }

  const exportedAt = new Date().toISOString();
  zip.file(
    'README.txt',
    [
      'iceCoder 记忆导出',
      '',
      `导出时间: ${exportedAt}`,
      `文件数: ${projectFiles.length + userFiles.length}`,
      '',
      '目录说明:',
      `  ${projectFolder}/  项目级记忆`,
      `  ${userFolder}/     用户级记忆`,
      '',
      '解压后可直接浏览 Markdown 文件；导入功能尚未提供，请妥善备份。',
    ].join('\n'),
  );

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { buffer, fileCount: projectFiles.length + userFiles.length };
}

/** 创建挂载于 /api/memory 的路由。 */
export function createMemoryExportRouter(llmAdapter?: LLMAdapter): Router {
  const router = Router();

  /**
   * GET /export — 下载 ZIP 压缩包。
   */
  router.get('/export', async (_req: Request, res: Response): Promise<void> => {
    try {
      const projectDir = path.resolve(DEFAULT_MEMORY_DIR);
      const userDir = path.resolve(DEFAULT_USER_MEMORY_DIR);
      const { buffer, fileCount } = await packMemoriesZip(projectDir, userDir);

      if (fileCount === 0) {
        res.status(404).json({ success: false, error: '没有可导出的记忆文件' });
        return;
      }

      const date = new Date().toISOString().split('T')[0];
      const filename = `icecoder-memory-${date}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Memory-File-Count', String(fileCount));
      res.send(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ success: false, error: `记忆导出失败: ${message}` });
    }
  });

  /**
   * GET /stats — 导出前预览统计。
   */
  router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
    try {
      const projectDir = path.resolve(DEFAULT_MEMORY_DIR);
      const userDir = path.resolve(DEFAULT_USER_MEMORY_DIR);
      const projectFiles = await scanMdFiles(projectDir);
      const userFiles = await scanMdFiles(userDir);

      res.json({
        success: true,
        project: { dir: projectDir, files: projectFiles.length },
        user: { dir: userDir, files: userFiles.length },
        total: projectFiles.length + userFiles.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ success: false, error: `统计失败: ${message}` });
    }
  });

  /**
   * POST /recall — 召回测试：给定 query，返回召回的记忆文件内容。
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
