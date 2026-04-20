/**
 * 聊天和文件上传 API 路由
 * 处理文件上传和聊天消息，触发 Pipeline 执行
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import type { Orchestrator } from '../../core/orchestrator.js';

const SUPPORTED_EXTENSIONS = ['.html', '.doc', '.docx', '.ppt', '.pptx', '.xmind'];

const upload = multer({ dest: 'data/uploads/' });

/**
 * 修复 multer 中文文件名乱码问题
 * multer 使用 latin1 编码存储 originalname，需要转回 utf8
 */
function fixFilename(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

/**
 * 验证上传文件是否为支持的格式
 */
function isSupportedFormat(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * Options for creating the chat router.
 */
export interface ChatRouterOptions {
  orchestrator: Orchestrator;
}

/**
 * Creates the chat API router.
 * Accepts an Orchestrator instance for triggering pipeline execution.
 */
export function createChatRouter(options: ChatRouterOptions): Router {
  const { orchestrator } = options;
  const router = Router();

  // Track uploaded files by a simple session/request basis
  const uploadedFiles: Map<string, { path: string; filename: string }> = new Map();

  /**
   * POST /api/chat/upload - 接收文件上传（multipart/form-data）
   * 验证文件格式并临时存储
   */
  router.post('/upload', upload.single('file'), (req: Request, res: Response): void => {
    try {
      const file = req.file;

      if (!file) {
        res.status(400).json({ error: '未上传文件' });
        return;
      }

      // 修复中文文件名乱码
      const originalName = fixFilename(file.originalname);

      if (!isSupportedFormat(originalName)) {
        const ext = path.extname(originalName) || 'unknown';
        res.status(400).json({
          error: `不支持的文件格式: ${ext}。支持的格式: ${SUPPORTED_EXTENSIONS.join(', ')}`,
        });
        return;
      }

      // 存储文件信息供后续使用
      const fileId = file.filename;
      uploadedFiles.set(fileId, {
        path: file.path,
        filename: originalName,
      });

      res.json({
        success: true,
        fileId,
        filename: originalName,
        size: file.size,
        mimetype: file.mimetype,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `文件上传失败: ${message}` });
    }
  });

  /**
   * POST /api/chat/message - 接收文本消息并触发 Pipeline 执行
   * 如果提供了 fileId，则使用已上传的文件作为 Pipeline 输入
   */
  router.post('/message', async (req: Request, res: Response): Promise<void> => {
    try {
      const { message, fileId } = req.body as { message?: string; fileId?: string };

      if (!message && !fileId) {
        res.status(400).json({ error: '需要提供消息或文件ID' });
        return;
      }

      let filePath: string | undefined;
      let filename: string | undefined;

      if (fileId) {
        const fileInfo = uploadedFiles.get(fileId);
        if (!fileInfo) {
          res.status(400).json({ error: '文件未找到，请先上传文件' });
          return;
        }
        filePath = fileInfo.path;
        filename = fileInfo.filename;
      }

      // 如果有文件，读取并触发 Pipeline 执行
      if (filePath && filename) {
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(filePath);

        // 异步执行 Pipeline，不等待完成
        // executePipeline 返回的 state 包含真实的 executionId
        const pipelinePromise = orchestrator.executePipeline(buffer, filename, {});

        // 等待一小段时间让 Pipeline 初始化，获取真实的 executionId
        await new Promise(resolve => setTimeout(resolve, 50));

        // 从 Orchestrator 获取最新的 Pipeline executionId
        const executionId = orchestrator.getLatestPipelineId() ?? 'unknown';

        // 后台继续执行 Pipeline
        pipelinePromise.catch((err) => {
          console.error(`Pipeline 执行失败 (${executionId}):`, err);
        });

        res.json({
          success: true,
          executionId,
          message: 'Pipeline 执行已启动',
          filename,
        });
      } else {
        // 纯文本消息 - 调用 LLM 生成回复
        try {
          const llmAdapter = orchestrator.getLLMAdapter();
          const llmResponse = await llmAdapter.chat([
            { role: 'user', content: message || '' },
          ]);
          res.json({
            success: true,
            message: '消息已接收',
            content: llmResponse.content,
          });
        } catch (llmErr) {
          const errMsg = llmErr instanceof Error ? llmErr.message : 'LLM 调用失败';
          res.json({
            success: true,
            message: '消息已接收',
            content: `LLM 错误: ${errMsg}`,
          });
        }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `消息处理失败: ${errMessage}` });
    }
  });

  return router;
}
